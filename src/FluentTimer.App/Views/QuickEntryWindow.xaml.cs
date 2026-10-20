using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using FluentTimer.App.Services;
using FluentTimer.Core;

namespace FluentTimer.App.Views;

/// <summary>Spotlight-style popup opened by the global hotkey.</summary>
public partial class QuickEntryWindow : Window
{
    private readonly AppHost _host;
    private bool _closing;

    internal QuickEntryWindow(AppHost host)
    {
        _host = host;
        InitializeComponent();

        // Saved timers first (with their own names), then the plain presets.
        foreach (var saved in host.State.SavedTimers)
            Presets.Children.Add(Preset($"{saved.DisplayName} · {TimeFormat.Friendly(saved.Duration)}", () => host.StartSaved(saved)));
        foreach (var m in host.Settings.PresetMinutes)
            Presets.Children.Add(Preset($"{m} min", () => host.StartCountdown(TimeSpan.FromMinutes(m), Input.Text.Trim())));
        Presets.Children.Add(Preset("Pomodoro", () => host.StartPomodoro(Input.Text.Trim())));

        var work = SystemParameters.WorkArea;
        Left = work.Left + (work.Width - Width) / 2;
        Top = work.Top + work.Height * 0.22;

        Loaded += (_, _) =>
        {
            Activate();
            Input.Focus();
            Keyboard.Focus(Input);
        };
        Deactivated += (_, _) => CloseOnce();
    }

    private Button Preset(string text, Action start)
    {
        var b = new Button { Content = text, Style = (Style)FindResource("ChipButton"), Margin = new Thickness(0, 0, 6, 0), Padding = new Thickness(12, 4, 12, 4) };
        b.Click += (_, _) =>
        {
            start();
            CloseOnce();
        };
        return b;
    }

    private void OnTextChanged(object sender, TextChangedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(Input.Text))
        {
            Preview.Text = "Type a duration, a time, or 'pomo'. Enter to start, Esc to close.";
            return;
        }
        Preview.Text = QuickEntryParser.TryParse(Input.Text, out var entry)
            ? $"Enter → {AppHost.Describe(entry)}"
            : "Not understood yet. Try 25m, 1h30, 90s, 5:00, at 14:30, 2pm, pomo";
    }

    private void OnInputKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            CloseOnce();
            e.Handled = true;
        }
        else if (e.Key == Key.Enter)
        {
            e.Handled = true;
            if (QuickEntryParser.TryParse(Input.Text, out var entry))
            {
                _host.Run(entry);
                CloseOnce();
            }
            else
            {
                Preview.Text = "Couldn't read that. Try 25m, 1h30, at 14:30 or pomo";
            }
        }
    }

    private void CloseOnce()
    {
        if (_closing) return;
        _closing = true;
        Close();
    }
}
