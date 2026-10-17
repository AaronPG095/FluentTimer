using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using FluentTimer.App.Services;
using FluentTimer.App.ViewModels;
using FluentTimer.Core;
using Microsoft.Win32;

namespace FluentTimer.App.Views.Pages;

public partial class SettingsPage : UserControl
{
    private readonly AppHost _host;
    private readonly SettingsVm _vm;

    internal SettingsPage(AppHost host)
    {
        _host = host;
        InitializeComponent();
        DataContext = _vm = new SettingsVm(host);
    }

    private void OnTestAlert(object sender, RoutedEventArgs e)
    {
        if (((FrameworkElement)sender).Tag is AlertEditorVm editor) _host.Alerts.Test(editor.Settings);
    }

    private void OnSoundChanged(object sender, SelectionChangedEventArgs e)
    {
        if (sender is not ComboBox { Tag: AlertEditorVm editor } combo) return;
        if (combo.SelectedItem as string != AlertEditorVm.CustomFile || e.AddedItems.Count == 0) return;
        if (!editor.CustomPath.Equals("", StringComparison.Ordinal) && e.RemovedItems.Count == 0) return; // initial bind

        var dialog = new OpenFileDialog { Filter = "Audio files (*.wav;*.mp3;*.wma;*.m4a)|*.wav;*.mp3;*.wma;*.m4a|All files|*.*" };
        if (dialog.ShowDialog() == true) editor.SetCustomSound(dialog.FileName);
        else combo.SelectedItem = editor.SoundChoice == AlertEditorVm.CustomFile && editor.CustomPath.Length > 0
            ? AlertEditorVm.CustomFile
            : e.RemovedItems.Count > 0 ? e.RemovedItems[0] : "Chime";
    }

    /// <summary>Shortcut recorder: shows the pressed combination and registers it once a real key is pressed.</summary>
    private void OnHotkeyKeyDown(object sender, KeyEventArgs e)
    {
        e.Handled = true;
        if (sender is not FrameworkElement { Tag: HotkeyRowVm row }) return;
        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        if (key is Key.Escape or Key.Tab)
        {
            Keyboard.ClearFocus();
            return;
        }
        if (key is Key.Back or Key.Delete && Keyboard.Modifiers == ModifierKeys.None)
        {
            _vm.SetHotkey(row, ""); // turn this shortcut off
            Keyboard.ClearFocus();
            return;
        }
        var gesture = HotkeyService.Format(Keyboard.Modifiers, key);
        if (gesture.Length == 0 || Keyboard.Modifiers == ModifierKeys.None) return;
        _vm.SetHotkey(row, gesture);
        Keyboard.ClearFocus();
    }

    private async void OnCheckUpdates(object sender, RoutedEventArgs e)
    {
        await _host.Updates.CheckAsync();
        _host.Settings.LastUpdateCheckUtc = DateTime.UtcNow;
        _host.SettingsChanged();
    }

    private void OnInstallUpdate(object sender, RoutedEventArgs e) => App.Current.InstallUpdate();

    private void OnOpenData(object sender, RoutedEventArgs e)
    {
        Directory.CreateDirectory(AppPaths.DataDir);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{AppPaths.DataDir}\"") { UseShellExecute = true });
    }
}
