using Microsoft.Win32;

namespace FluentTimer.App.Services;

/// <summary>Per-user auto-start via HKCU\Software\Microsoft\Windows\CurrentVersion\Run. No admin needed.</summary>
internal static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "FluentTimer";
    public const string MinimizedArg = "--minimized";

    private static string Command => $"\"{Environment.ProcessPath}\" {MinimizedArg}";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(ValueName) is string;
    }

    /// <summary>Adds, refreshes (if the exe moved) or removes the Run entry.</summary>
    public static void Apply(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
        if (enabled)
        {
            if (key.GetValue(ValueName) as string != Command) key.SetValue(ValueName, Command);
        }
        else if (key.GetValue(ValueName) is not null)
        {
            key.DeleteValue(ValueName);
        }
    }
}
