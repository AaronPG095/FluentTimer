using System.IO;
using System.Windows;
using System.Windows.Controls;
using FluentTimer.App.Services;
using FluentTimer.Core;
using Microsoft.Win32;

namespace FluentTimer.App.Views.Pages;

public partial class HistoryPage : UserControl
{
    private readonly AppHost _host;
    private List<SessionRecord> _visible = [];

    internal HistoryPage(AppHost host)
    {
        _host = host;
        InitializeComponent();
        RangeBox.SelectedIndex = 1;
        host.HistoryChanged += () => Dispatcher.BeginInvoke(Reload);
        IsVisibleChanged += (_, _) => { if (IsVisible) Reload(); };
    }

    private void OnRangeChanged(object sender, SelectionChangedEventArgs e) => Reload();

    private (DateTime From, DateTime To) Period()
    {
        var now = _host.Clock.LocalNow();
        var tomorrow = now.Date.AddDays(1);
        return RangeBox.SelectedIndex switch
        {
            0 => (now.Date, tomorrow),
            1 => (HistoryReport.StartOfWeek(now), tomorrow),
            2 => (now.Date.AddDays(-6), tomorrow),
            3 => (new DateTime(now.Year, now.Month, 1), tomorrow),
            _ => (DateTime.MinValue, DateTime.MaxValue),
        };
    }

    private void Reload()
    {
        if (TotalsList is null) return;
        var (from, to) = Period();
        _visible = HistoryReport.InRange(_host.History, _host.Clock, from, to).OrderByDescending(r => r.EndedUtc).ToList();

        var totals = HistoryReport.Totals(_visible);
        var max = totals.Count > 0 ? totals.Max(t => t.Total.TotalSeconds) : 1;
        TotalsList.ItemsSource = totals.Select(t => new
        {
            t.Label,
            Fraction = max > 0 ? t.Total.TotalSeconds / max : 0,
            TotalText = TimeFormat.Total(t.Total),
            SessionsText = t.Sessions == 1 ? "1 session" : $"{t.Sessions} sessions",
        }).ToList();
        NoTotals.Visibility = totals.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        TotalText.Text = TimeFormat.Total(new TimeSpan(_visible.Sum(r => r.Duration.Ticks)));
        CountText.Text = _visible.Count.ToString();
        CompletedText.Text = _visible.Count(r => r.Completed).ToString();
        SessionsTitle.Visibility = SessionsCard.Visibility = _visible.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

        SessionList.ItemsSource = _visible.Take(300).Select(r =>
        {
            var start = _host.Clock.ToLocal(r.StartedUtc);
            var end = _host.Clock.ToLocal(r.EndedUtc);
            return new
            {
                Date = start.ToString("ddd d MMM"),
                Span = $"{start:HH:mm}–{end:HH:mm}",
                Label = string.IsNullOrWhiteSpace(r.Label) ? HistoryReport.NoLabel : r.Label,
                Kind = r.Kind == TimerKind.Pomodoro ? "Focus" : "Timer",
                Duration = TimeFormat.Total(r.Duration),
                Check = r.Completed ? "" : "",
            };
        }).ToList();
    }

    private void OnExport(object sender, RoutedEventArgs e)
    {
        var dialog = new SaveFileDialog
        {
            FileName = $"fluent-timer-{DateTime.Now:yyyy-MM-dd}.csv",
            Filter = "CSV file (*.csv)|*.csv",
            DefaultExt = ".csv",
        };
        if (dialog.ShowDialog() != true) return;
        File.WriteAllText(dialog.FileName, HistoryReport.ToCsv(_visible, _host.Clock), new System.Text.UTF8Encoding(true));
    }

    private void OnClear(object sender, RoutedEventArgs e)
    {
        var answer = MessageBox.Show("Delete all tracked history? This can't be undone.", "Fluent Timer",
            MessageBoxButton.OKCancel, MessageBoxImage.Warning, MessageBoxResult.Cancel);
        if (answer == MessageBoxResult.OK) _host.ClearHistory();
    }
}
