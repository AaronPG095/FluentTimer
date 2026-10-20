using System.Collections.ObjectModel;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using FluentTimer.App.Services;
using FluentTimer.Core;

namespace FluentTimer.App.ViewModels;

public sealed class DayVm : ObservableObject
{
    private static readonly DayOfWeek[] Order =
        [DayOfWeek.Monday, DayOfWeek.Tuesday, DayOfWeek.Wednesday, DayOfWeek.Thursday, DayOfWeek.Friday, DayOfWeek.Saturday, DayOfWeek.Sunday];

    private readonly List<DayOfWeek> _days;
    private readonly Action _changed;

    private DayVm(DayOfWeek day, List<DayOfWeek> days, Action changed)
    {
        Day = day;
        _days = days;
        _changed = changed;
    }

    public DayOfWeek Day { get; }
    public string Letter => CultureInfo.CurrentCulture.DateTimeFormat.GetShortestDayName(Day)[..1];
    public string Name => CultureInfo.CurrentCulture.DateTimeFormat.GetDayName(Day);

    public bool IsOn
    {
        get => _days.Contains(Day);
        set
        {
            if (value == IsOn) return;
            if (value) _days.Add(Day); else _days.Remove(Day);
            OnPropertyChanged();
            _changed();
        }
    }

    public static ObservableCollection<DayVm> For(List<DayOfWeek> days, Action changed) =>
        new(Order.Select(d => new DayVm(d, days, changed)));
}

/// <summary>Editable view of an interval reminder; writes straight through to the model.</summary>
public sealed class ReminderVm : ObservableObject
{
    private readonly AppHost _host;
    private string _status = "";

    internal ReminderVm(IntervalReminder model, AppHost host)
    {
        Model = model;
        _host = host;
        Days = DayVm.For(model.Days, Changed);
        _breakText = model.BreakDuration is { } b ? Short(b) : "5m";
    }

    public IntervalReminder Model { get; }
    public ObservableCollection<DayVm> Days { get; }

    public bool Enabled { get => Model.Enabled; set { Model.Enabled = value; Changed(); } }
    public string Label { get => Model.Label; set { Model.Label = value; _host.StateEdited(); } }

    public double? IntervalMinutes
    {
        get => Model.Interval.TotalMinutes;
        set
        {
            if (value is not > 0) return;
            Model.Interval = TimeSpan.FromMinutes(Math.Round(value.Value));
            Changed();
        }
    }

    public string From
    {
        get => Model.ActiveFrom.ToString("HH:mm");
        set { if (TryTime(value, out var t)) { Model.ActiveFrom = t; Changed(); } OnPropertyChanged(); }
    }

    public string To
    {
        get => Model.ActiveTo.ToString("HH:mm");
        set { if (TryTime(value, out var t)) { Model.ActiveTo = t; Changed(); } OnPropertyChanged(); }
    }

    public bool HasBreak
    {
        get => Model.BreakDuration is not null;
        set
        {
            Model.BreakDuration = value && QuickEntryParser.TryParseDuration(_breakText, out var d) ? d : value ? TimeSpan.FromMinutes(5) : null;
            OnPropertyChanged();
            Changed();
        }
    }

    private string _breakText;
    public string BreakText
    {
        get => _breakText;
        set
        {
            _breakText = value;
            if (QuickEntryParser.TryParseDuration(value, out var d))
            {
                if (HasBreak) Model.BreakDuration = d;
                Changed();
            }
            OnPropertyChanged();
        }
    }

    public string Status { get => _status; private set => SetProperty(ref _status, value); }

    public void Refresh(IClock clock)
    {
        if (!Model.Enabled) Status = "Off";
        else if (!Model.IsActiveAt(clock.LocalNow())) Status = "Outside active hours";
        else if (_host.Engine.IsSuspended) Status = "Paused while you're away";
        else if (Model.NextDueUtc is { } next) Status = $"Next at {clock.ToLocal(next):HH:mm}";
        else Status = "Starting…";
    }

    private void Changed()
    {
        _host.Engine.ResetReminder(Model);
        _host.StateEdited();
    }

    internal static bool TryTime(string? text, out TimeOnly time) =>
        TimeOnly.TryParseExact((text ?? "").Trim(), ["H:mm", "HH:mm", "H.mm", "Hmm", "HHmm", "H"], CultureInfo.InvariantCulture, DateTimeStyles.None, out time);

    private static string Short(TimeSpan t) => t.TotalSeconds < 60 ? $"{t.TotalSeconds:0}s" : $"{t.TotalMinutes:0}m";
}

/// <summary>Editable view of a saved timer; edits write straight through to the model.</summary>
public sealed class SavedTimerVm : ObservableObject
{
    private readonly AppHost _host;
    private string _durationText;

    internal SavedTimerVm(SavedTimer model, AppHost host)
    {
        Model = model;
        _host = host;
        _durationText = Short(model.Duration);
    }

    public SavedTimer Model { get; }

    public string Name
    {
        get => Model.Name;
        set
        {
            var clean = (value ?? "").Trim();
            if (clean == Model.Name) return;
            Model.Name = clean.Length > 60 ? clean[..60] : clean;
            OnPropertyChanged();
            _host.StateEdited();
        }
    }

    /// <summary>Length as typed: "25m", "1h", "1h30", "90s", "5:00".</summary>
    public string DurationText
    {
        get => _durationText;
        set
        {
            if (QuickEntryParser.TryParseDuration(value, out var d))
            {
                Model.Duration = d;
                _durationText = Short(d);
                _host.StateEdited();
            }
            OnPropertyChanged(); // invalid input snaps back to the last good value
        }
    }

    public bool Repeat
    {
        get => Model.Repeat;
        set { Model.Repeat = value; OnPropertyChanged(); _host.StateEdited(); }
    }

    internal static string Short(TimeSpan t)
    {
        if (t < TimeSpan.FromMinutes(1)) return $"{t.TotalSeconds:0}s";
        var h = (int)t.TotalHours;
        var m = t.Minutes;
        var s = t.Seconds;
        var text = (h > 0 ? $"{h}h" : "") + (m > 0 ? $"{m}m" : "") + (s > 0 ? $"{s}s" : "");
        return text.Length > 0 ? text : "0m";
    }
}

public sealed class AlarmVm : ObservableObject
{
    private readonly AppHost _host;

    internal AlarmVm(Alarm model, AppHost host)
    {
        Model = model;
        _host = host;
        Days = DayVm.For(model.RepeatDays, () =>
        {
            if (!Model.IsRepeating) Model.Date = NextDate();
            Changed();
        });
    }

    public Alarm Model { get; }
    public ObservableCollection<DayVm> Days { get; }

    public bool Enabled
    {
        get => Model.Enabled;
        set
        {
            Model.Enabled = value;
            if (value && !Model.IsRepeating) Model.Date = NextDate();
            Changed();
        }
    }

    public string Label { get => Model.Label; set { Model.Label = value; _host.StateEdited(); } }

    public string Time
    {
        get => Model.Time.ToString("HH:mm");
        set
        {
            if (ReminderVm.TryTime(value, out var t))
            {
                Model.Time = t;
                Model.LastFired = null;
                if (!Model.IsRepeating) Model.Date = NextDate();
                Changed();
            }
            OnPropertyChanged();
        }
    }

    public string Summary
    {
        get
        {
            if (Model.IsRepeating)
                return Model.RepeatDays.Count == 7 ? "Every day" : "Repeats " + string.Join(", ",
                    Days.Where(d => d.IsOn).Select(d => CultureInfo.CurrentCulture.DateTimeFormat.GetAbbreviatedDayName(d.Day)));
            if (!Model.Enabled || Model.Date is not { } date) return "One-off · off";
            var today = DateOnly.FromDateTime(_host.Clock.LocalNow());
            return date == today ? "One-off · today" : date == today.AddDays(1) ? "One-off · tomorrow" : $"One-off · {date:ddd d MMM}";
        }
    }

    /// <summary>The engine may have fired or disabled a one-off alarm.</summary>
    public void OnTick()
    {
        OnPropertyChanged(nameof(Enabled));
        OnPropertyChanged(nameof(Summary));
    }

    private DateOnly NextDate() => TimerEngine.NextOccurrenceDate(Model.Time, _host.Clock.LocalNow());

    private void Changed()
    {
        OnPropertyChanged(nameof(Summary));
        OnPropertyChanged(nameof(Enabled));
        _host.StateEdited();
    }
}
