using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using FluentTimer.App.Services;
using FluentTimer.App.ViewModels;
using FluentTimer.Core;

namespace FluentTimer.App.Views.Pages;

public partial class RemindersPage : UserControl
{
    private readonly AppHost _host;
    private readonly ObservableCollection<ReminderVm> _reminders;
    private readonly ObservableCollection<AlarmVm> _alarms;
    private int _refresh;

    internal RemindersPage(AppHost host)
    {
        _host = host;
        InitializeComponent();
        _reminders = new(host.State.Reminders.Select(r => new ReminderVm(r, host)));
        _alarms = new(host.State.Alarms.Select(a => new AlarmVm(a, host)));
        ReminderList.ItemsSource = _reminders;
        AlarmList.ItemsSource = _alarms;

        host.Ticked += () =>
        {
            if (++_refresh % 4 != 0 || !IsVisible) return;
            SyncAlarms();
            foreach (var r in _reminders) r.Refresh(host.Clock);
        };
    }

    /// <summary>Alarms can also be created from quick entry while this page is cached.</summary>
    private void SyncAlarms()
    {
        foreach (var a in _host.State.Alarms)
            if (_alarms.All(vm => vm.Model != a)) _alarms.Add(new AlarmVm(a, _host));
        foreach (var vm in _alarms.Where(vm => !_host.State.Alarms.Contains(vm.Model)).ToList())
            _alarms.Remove(vm);
        foreach (var vm in _alarms) vm.OnTick();
    }

    private void OnAddReminder(object sender, RoutedEventArgs e)
    {
        var r = new IntervalReminder { Label = "New reminder" };
        _host.State.Reminders.Add(r);
        _reminders.Add(new ReminderVm(r, _host));
        _host.StateEdited();
    }

    private void OnDeleteReminder(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is not ReminderVm vm) return;
        _host.State.Reminders.Remove(vm.Model);
        _reminders.Remove(vm);
        _host.StateEdited();
    }

    private void OnAddAlarm(object sender, RoutedEventArgs e)
    {
        var time = TimeOnly.FromDateTime(_host.Clock.LocalNow().AddHours(1));
        time = new TimeOnly(time.Hour, 0);
        var a = new Alarm { Label = "Alarm", Time = time, Date = TimerEngine.NextOccurrenceDate(time, _host.Clock.LocalNow()) };
        _host.State.Alarms.Add(a);
        _alarms.Add(new AlarmVm(a, _host));
        _host.StateEdited();
    }

    private void OnDeleteAlarm(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is not AlarmVm vm) return;
        _host.State.Alarms.Remove(vm.Model);
        _alarms.Remove(vm);
        _host.StateEdited();
    }
}
