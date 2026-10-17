using System.Windows.Input;
using System.Windows.Interop;

namespace FluentTimer.App.Services;

public enum HotkeyAction { QuickAdd, PauseResume, Dismiss, ToggleWidget }

/// <summary>System-wide hotkeys registered on an invisible message-only window.</summary>
internal sealed class HotkeyService : IDisposable
{
    private const int BaseId = 0x4654; // "FT"
    private readonly HwndSource _source;
    private readonly HashSet<HotkeyAction> _registered = [];

    public HotkeyService()
    {
        _source = new HwndSource(new HwndSourceParameters("FluentTimer.Hotkey")
        {
            ParentWindow = Native.HWND_MESSAGE,
            Width = 0,
            Height = 0,
            WindowStyle = 0,
        });
        _source.AddHook(WndProc);
    }

    public event Action<HotkeyAction>? Pressed;

    /// <summary>
    /// Registers every action's gesture (e.g. "Ctrl+Alt+T"; empty = off).
    /// Returns an error per action that could not be registered.
    /// </summary>
    public Dictionary<HotkeyAction, string> RegisterAll(IReadOnlyDictionary<HotkeyAction, string> gestures)
    {
        foreach (var a in _registered) Native.UnregisterHotKey(_source.Handle, BaseId + (int)a);
        _registered.Clear();

        var errors = new Dictionary<HotkeyAction, string>();
        var seen = new Dictionary<string, HotkeyAction>(StringComparer.OrdinalIgnoreCase);
        foreach (var (action, gesture) in gestures)
        {
            if (string.IsNullOrWhiteSpace(gesture)) continue;
            if (!TryParse(gesture, out var mods, out var key)) { errors[action] = "Not a valid shortcut"; continue; }
            if (seen.TryGetValue(gesture.Trim(), out var other)) { errors[action] = $"Same as {Describe(other)}"; continue; }
            seen[gesture.Trim()] = action;

            var vk = (uint)KeyInterop.VirtualKeyFromKey(key);
            if (Native.RegisterHotKey(_source.Handle, BaseId + (int)action, (uint)(mods | Native.Modifiers.NoRepeat), vk))
                _registered.Add(action);
            else
                errors[action] = "Already used by another app";
        }
        return errors;
    }

    public static string Describe(HotkeyAction action) => action switch
    {
        HotkeyAction.QuickAdd => "Quick add",
        HotkeyAction.PauseResume => "Pause / resume",
        HotkeyAction.Dismiss => "Dismiss alert",
        _ => "Show / hide widget",
    };

    public static bool TryParse(string gesture, out Native.Modifiers mods, out Key key)
    {
        mods = Native.Modifiers.None;
        key = Key.None;
        foreach (var raw in gesture.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            switch (raw.ToLowerInvariant())
            {
                case "ctrl" or "control": mods |= Native.Modifiers.Ctrl; break;
                case "alt": mods |= Native.Modifiers.Alt; break;
                case "shift": mods |= Native.Modifiers.Shift; break;
                case "win" or "windows": mods |= Native.Modifiers.Win; break;
                default:
                    if (key != Key.None || !Enum.TryParse(raw, ignoreCase: true, out key)) return false;
                    break;
            }
        }
        // Require a modifier so plain typing is never hijacked.
        return key != Key.None && mods != Native.Modifiers.None;
    }

    /// <summary>Formats a key event from a recorder box, e.g. "Ctrl+Shift+Space". Empty while only modifiers are held.</summary>
    public static string Format(ModifierKeys mods, Key key)
    {
        if (key is Key.LeftCtrl or Key.RightCtrl or Key.LeftAlt or Key.RightAlt or Key.LeftShift or Key.RightShift
            or Key.LWin or Key.RWin or Key.System or Key.None) return "";
        var parts = new List<string>();
        if (mods.HasFlag(ModifierKeys.Control)) parts.Add("Ctrl");
        if (mods.HasFlag(ModifierKeys.Alt)) parts.Add("Alt");
        if (mods.HasFlag(ModifierKeys.Shift)) parts.Add("Shift");
        if (mods.HasFlag(ModifierKeys.Windows)) parts.Add("Win");
        parts.Add(key.ToString());
        return string.Join("+", parts);
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        var id = wParam.ToInt32() - BaseId;
        if (msg == Native.WM_HOTKEY && Enum.IsDefined(typeof(HotkeyAction), id))
        {
            handled = true;
            Pressed?.Invoke((HotkeyAction)id);
        }
        return IntPtr.Zero;
    }

    public void Dispose()
    {
        RegisterAll(new Dictionary<HotkeyAction, string>());
        _source.Dispose();
    }
}
