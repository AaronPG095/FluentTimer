using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using FluentTimer.Core;
using Microsoft.Win32;
using Wpf.Ui.Appearance;
using Wpf.Ui.Controls;

namespace FluentTimer.App.Services;

/// <summary>
/// Applies the FluentOverlay palette (same tokens and hex values as FO-StylingGuide) plus accent colour.
/// All app surfaces use DynamicResource so switching theme updates live.
/// </summary>
internal static class ThemeService
{
    public static readonly Color BrandBlue = Color.FromRgb(0x00, 0x78, 0xD4);
    public static readonly Color AlertRed = Color.FromRgb(0xC4, 0x2B, 0x1C);

    private static readonly Dictionary<string, (string Dark, string Light)> Palette = new()
    {
        ["ContentBackgroundBrush"] = ("#202020", "#F3F3F3"),
        ["ColumnCardBrush"] = ("#2D2D2D", "#FFFFFF"),
        ["ColumnDividerBrush"] = ("#434343", "#E0E0E0"),
        ["SearchBarBackground"] = ("#2B2B2B", "#FFFFFF"),
        ["ButtonBackgroundBrush"] = ("#282828", "#FBFBFB"),
        ["OverlayForegroundBrush"] = ("#FFFFFF", "#1A1A1A"),
        ["NoResultsForeground"] = ("#BEBEBE", "#5E5E5E"),
        ["FooterForeground"] = ("#909090", "#6E6E6E"),
        ["TabStripBackground"] = ("#1A1A1A", "#EBEBEB"),
        ["TabActiveBackground"] = ("#333333", "#FFFFFF"),
        ["TabInactiveForeground"] = ("#B0B0B0", "#5E5E5E"),
        ["TabHoverBackground"] = ("#25FFFFFF", "#15000000"),
        ["PillBackgroundBrush"] = ("#F0202020", "#F5FBFBFB"),
        ["PillBorderBrush"] = ("#55434343", "#40000000"),
        ["ScrimBrush"] = ("#B3000000", "#99000000"),
    };

    public static bool IsDark { get; private set; } = true;
    private static ApplicationTheme? _appliedTheme;

    /// <summary>Set once App.EnsureFluentUi has merged WPF-UI's dictionaries.</summary>
    public static bool FluentUiLoaded { get; set; }

    public static void Apply(AppSettings settings)
    {
        IsDark = settings.Theme switch
        {
            AppTheme.Dark => true,
            AppTheme.Light => false,
            _ => SystemPrefersDark(),
        };
        var theme = IsDark ? ApplicationTheme.Dark : ApplicationTheme.Light;
        // Only re-theme when it actually changes: WPF-UI also touches window backdrops when applying.
        if (FluentUiLoaded && _appliedTheme != theme)
        {
            ApplicationThemeManager.Apply(theme, WindowBackdropType.None, updateAccent: false);
            _appliedTheme = theme;
        }

        var res = Application.Current.Resources;
        foreach (var (key, (dark, light)) in Palette)
            res[key] = Freeze(new SolidColorBrush((Color)ColorConverter.ConvertFromString(IsDark ? dark : light)));

        var accent = ResolveAccent(settings);
        if (FluentUiLoaded) ApplicationAccentColorManager.Apply(accent, theme, false, false);
        res["OverlayAccentBrush"] = Freeze(new SolidColorBrush(accent));
        res["OverlayAccentColor"] = accent;
        res["AlertBrush"] = Freeze(new SolidColorBrush(AlertRed));
        res["AlertColor"] = AlertRed;
        RestoreWindowBackgrounds();
    }

    /// <summary>
    /// WPF-UI's theme manager paints Application.MainWindow (the first window created, i.e. the pill) with a
    /// solid theme background, which would fill the pill's transparent headroom. Put every window's own background back.
    /// </summary>
    private static void RestoreWindowBackgrounds()
    {
        foreach (Window w in Application.Current.Windows)
        {
            if (w is Views.DimOverlayWindow) w.SetResourceReference(Control.BackgroundProperty, "ScrimBrush");
            else if (w.AllowsTransparency) w.Background = Brushes.Transparent;
            else w.SetResourceReference(Control.BackgroundProperty, "ContentBackgroundBrush");
        }
    }

    public static Color ResolveAccent(AppSettings settings) => settings.Accent switch
    {
        AccentMode.System => ApplicationAccentColorManager.GetColorizationColor(),
        AccentMode.Custom when TryParseColor(settings.CustomAccent, out var c) => c,
        _ => BrandBlue,
    };

    public static bool TryParseColor(string? text, out Color color)
    {
        color = BrandBlue;
        try
        {
            if (string.IsNullOrWhiteSpace(text)) return false;
            var hex = text.Trim();
            if (!hex.StartsWith('#')) hex = "#" + hex;
            color = (Color)ColorConverter.ConvertFromString(hex);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static bool SystemPrefersDark()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        return key?.GetValue("AppsUseLightTheme") is not int light || light == 0;
    }

    private static SolidColorBrush Freeze(SolidColorBrush b)
    {
        b.Freeze();
        return b;
    }
}
