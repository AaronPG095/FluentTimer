using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using FluentTimer.App.Services;
using FluentTimer.Core;
using Microsoft.Win32;

namespace FluentTimer.App.Views.Pages;

/// <summary>Editable session row: the label writes straight back to the record.</summary>
internal sealed class SessionRow(SessionRecord record, AppHost host, IClock clock)
{
    public SessionRecord Record { get; } = record;
    public string Date => clock.ToLocal(Record.StartedUtc).ToString("ddd d MMM");
    public string Span => $"{clock.ToLocal(Record.StartedUtc):HH:mm}–{clock.ToLocal(Record.EndedUtc):HH:mm}";
    public string Kind => Record.Kind != TimerKind.Pomodoro ? "Timer"
        : Record.Interruptions == 0 ? "Pomodoro"
        : $"Pomodoro · {Record.Interruptions}×";
    public string Duration => TimeFormat.Total(Record.Duration);
    public string Check => Record.Completed ? "" : "";

    public string Label
    {
        get => Record.Label;
        set
        {
            if (value.Trim() == Record.Label) return;
            Record.Label = value.Trim();
            host.HistoryEdited();
        }
    }
}

public partial class HistoryPage : UserControl
{
    // Validated categorical slots 1–4 (dataviz reference palette), dark / light, plus a neutral "Other".
    private static readonly string[] DarkSeries = ["#3987e5", "#d95926", "#199e70", "#c98500"];
    private static readonly string[] LightSeries = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
    private const string DarkOther = "#6f6e69";
    private const string LightOther = "#a3a29b";
    private const int SeriesCount = 4;

    private readonly AppHost _host;
    private List<SessionRecord> _visible = [];

    internal HistoryPage(AppHost host)
    {
        _host = host;
        InitializeComponent();
        RangeBox.SelectedIndex = 1;
        AddDate.SelectedDate = DateTime.Today;
        host.HistoryChanged += () => Dispatcher.BeginInvoke(Reload);
        host.SettingsApplied += () => Dispatcher.BeginInvoke(Reload); // theme switch recolours the chart
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

    /// <summary>Days shown in the chart: a week for short periods, the month, or the last 30 days for all time.</summary>
    private (DateOnly First, int Days) ChartDays()
    {
        var today = DateOnly.FromDateTime(_host.Clock.LocalNow());
        return RangeBox.SelectedIndex switch
        {
            0 or 2 => (today.AddDays(-6), 7),
            1 => (DateOnly.FromDateTime(HistoryReport.StartOfWeek(_host.Clock.LocalNow())), 7),
            3 => (new DateOnly(today.Year, today.Month, 1), DateTime.DaysInMonth(today.Year, today.Month)),
            _ => (today.AddDays(-29), 30),
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
            SessionsText = t.Pomodoros > 0
                ? (t.Pomodoros == 1 ? "1 pomodoro" : $"{t.Pomodoros} pomodoros")
                : t.Sessions == 1 ? "1 session" : $"{t.Sessions} sessions",
        }).ToList();
        NoTotals.Visibility = totals.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        TotalText.Text = TimeFormat.Total(new TimeSpan(_visible.Sum(r => r.Duration.Ticks)));
        CountText.Text = _visible.Count.ToString();
        CompletedText.Text = _visible.Count(r => r.Completed).ToString();
        PomodoroText.Text = _visible.Count(r => r.IsCompletedPomodoro).ToString();
        InterruptionText.Text = _visible.Sum(r => r.Interruptions).ToString();
        SessionsCard.Visibility = _visible.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        SessionList.ItemsSource = _visible.Take(300).Select(r => new SessionRow(r, _host, _host.Clock)).ToList();

        BuildChart();
    }

    // ---- Chart -------------------------------------------------------------------------------

    private void BuildChart()
    {
        var dark = ThemeService.IsDark;
        var palette = (dark ? DarkSeries : LightSeries).Select(Brush).ToArray();
        var other = Brush(dark ? DarkOther : LightOther);
        var surface = (Brush)FindResource("ColumnCardBrush");

        var series = HistoryReport.SeriesLabels(_host.History, SeriesCount);
        var (first, count) = ChartDays();
        var days = HistoryReport.Daily(_host.History, _host.Clock, first, count, series);
        var anyOther = days.Any(d => d.BySeries[^1] > TimeSpan.Zero);

        // Legend: always present for >= 2 series; colour is never the only cue (tooltips + table below).
        Legend.Children.Clear();
        for (var i = 0; i < series.Count; i++) Legend.Children.Add(LegendItem(series[i], palette[i]));
        if (anyOther) Legend.Children.Add(LegendItem(HistoryReport.Other, other));
        Legend.Visibility = series.Count + (anyOther ? 1 : 0) >= 2 ? Visibility.Visible : Visibility.Collapsed;

        var peak = Math.Max(days.Max(d => d.Total.TotalMinutes), 1);
        var scaleMax = NiceCeiling(peak);
        AxisMax.Text = TimeFormat.Total(TimeSpan.FromMinutes(scaleMax));

        Bars.Children.Clear();
        Bars.ColumnDefinitions.Clear();
        const double plotHeight = 150 - 18; // leave room for day labels
        var labelEvery = count <= 7 ? 1 : count <= 14 ? 2 : 5;

        for (var i = 0; i < count; i++)
        {
            Bars.ColumnDefinitions.Add(new ColumnDefinition());
            var day = days[i];
            var column = new Grid { Background = Brushes.Transparent }; // whole column is the hover target
            Grid.SetColumn(column, i);

            var stack = new StackPanel { VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 0, 18), MaxWidth = 34 };
            // Draw from top segment to bottom; series order bottom-up = slot 1 at the base.
            var segments = Enumerable.Range(0, day.BySeries.Length)
                .Where(s => day.BySeries[s] > TimeSpan.Zero).Reverse().ToList();
            for (var k = 0; k < segments.Count; k++)
            {
                var s = segments[k];
                var h = Math.Max(2, day.BySeries[s].TotalMinutes / scaleMax * plotHeight);
                stack.Children.Add(new Border
                {
                    Height = h,
                    Background = s < series.Count ? palette[s] : other,
                    CornerRadius = k == 0 ? new CornerRadius(4, 4, 0, 0) : new CornerRadius(0),
                    BorderBrush = surface,
                    BorderThickness = new Thickness(0, 0, 0, k < segments.Count - 1 ? 2 : 0), // 2px surface gap between fills
                });
            }
            column.Children.Add(stack);

            if (i % labelEvery == 0 || i == count - 1)
            {
                column.Children.Add(new TextBlock
                {
                    Text = count <= 7 ? day.Day.ToString("ddd") : day.Day.Day.ToString(),
                    Style = (Style)FindResource("MutedText"),
                    FontSize = 11,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Bottom,
                });
            }

            column.ToolTip = Tooltip(day, series);
            Bars.Children.Add(column);
        }
    }

    private static string Tooltip(DayTotals day, IReadOnlyList<string> series)
    {
        if (day.Total == TimeSpan.Zero) return $"{day.Day:ddd d MMM}: nothing tracked";
        var lines = new List<string> { $"{day.Day:ddd d MMM} · {TimeFormat.Total(day.Total)}" };
        for (var s = 0; s < day.BySeries.Length; s++)
            if (day.BySeries[s] > TimeSpan.Zero)
                lines.Add($"{(s < series.Count ? series[s] : HistoryReport.Other)}: {TimeFormat.Total(day.BySeries[s])}");
        return string.Join("\n", lines);
    }

    private UIElement LegendItem(string label, Brush brush) => new StackPanel
    {
        Orientation = Orientation.Horizontal,
        Margin = new Thickness(0, 0, 16, 4),
        Children =
        {
            new Rectangle { Width = 10, Height = 10, RadiusX = 2, RadiusY = 2, Fill = brush, Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center },
            new TextBlock { Text = label, Style = (Style)FindResource("MutedText") },
        },
    };

    /// <summary>Round the axis top up to a readable step (15 min, 30 min, 1 h, 2 h …).</summary>
    private static double NiceCeiling(double minutes)
    {
        foreach (var step in new[] { 15.0, 30, 60, 120, 180, 240, 360, 480, 600, 720, 960, 1440 })
            if (minutes <= step) return step;
        return Math.Ceiling(minutes / 60) * 60;
    }

    private static SolidColorBrush Brush(string hex)
    {
        var b = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
        b.Freeze();
        return b;
    }

    // ---- Editing -----------------------------------------------------------------------------

    private void OnToggleAdd(object sender, RoutedEventArgs e) =>
        AddCard.Visibility = AddCard.Visibility == Visibility.Visible ? Visibility.Collapsed : Visibility.Visible;

    private void OnAdd(object sender, RoutedEventArgs e)
    {
        if (AddDate.SelectedDate is not { } date) { AddError.Text = "Pick a date"; return; }
        if (!ViewModels.ReminderVm.TryTime(AddStart.Text, out var start)) { AddError.Text = "Start as HH:mm"; return; }
        if (!QuickEntryParser.TryParseDuration(AddLength.Text, out var length)) { AddError.Text = "Length like 25m or 1h30"; return; }
        AddError.Text = "";
        _host.AddSession(AddLabel.Text, date.Date + start.ToTimeSpan(), length);
        AddLabel.Clear();
        AddCard.Visibility = Visibility.Collapsed;
    }

    private void OnDeleteSession(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is SessionRow row) _host.DeleteSession(row.Record);
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
