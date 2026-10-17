using System.Text.Json;

namespace FluentTimer.Core;

/// <summary>The parts of a GitHub "latest release" response the updater needs.</summary>
public sealed record ReleaseInfo(Version Version, string Tag, string PageUrl, string ExeUrl, string? Sha256Url, string Notes)
{
    public const string Repo = "AaronPG095/FluentTimer";
    public const string LatestApi = $"https://api.github.com/repos/{Repo}/releases/latest";
    public const string ExeName = "FluentTimer.exe";

    /// <summary>Parses the GitHub API JSON. Returns null for drafts, pre-releases, or releases without the exe.</summary>
    public static ReleaseInfo? TryParse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.TryGetProperty("draft", out var d) && d.GetBoolean()) return null;
            if (root.TryGetProperty("prerelease", out var p) && p.GetBoolean()) return null;

            var tag = root.GetProperty("tag_name").GetString() ?? "";
            if (!TryParseVersion(tag, out var version)) return null;

            string? exe = null, sha = null;
            foreach (var asset in root.GetProperty("assets").EnumerateArray())
            {
                var name = asset.GetProperty("name").GetString();
                var url = asset.GetProperty("browser_download_url").GetString();
                if (url is null || !IsTrustedDownload(url)) continue;
                if (string.Equals(name, ExeName, StringComparison.OrdinalIgnoreCase)) exe = url;
                else if (string.Equals(name, ExeName + ".sha256", StringComparison.OrdinalIgnoreCase)) sha = url;
            }
            if (exe is null) return null;

            return new ReleaseInfo(version, tag,
                root.TryGetProperty("html_url", out var page) ? page.GetString() ?? "" : "",
                exe, sha,
                root.TryGetProperty("body", out var body) ? body.GetString() ?? "" : "");
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>"v0.2.0" or "0.2" → Version. Ignores a "-suffix".</summary>
    public static bool TryParseVersion(string text, out Version version)
    {
        var core = text.Trim().TrimStart('v', 'V').Split('-', '+')[0];
        if (Version.TryParse(core, out var v))
        {
            version = new Version(v.Major, v.Minor, Math.Max(0, v.Build));
            return true;
        }
        version = new Version(0, 0, 0);
        return false;
    }

    public bool IsNewerThan(Version current) =>
        Version > new Version(current.Major, current.Minor, Math.Max(0, current.Build));

    /// <summary>Only download release assets of this repository over HTTPS.</summary>
    public static bool IsTrustedDownload(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps &&
        u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) &&
        u.AbsolutePath.StartsWith($"/{Repo}/releases/download/", StringComparison.OrdinalIgnoreCase);

    /// <summary>Reads the hash from a "sha256sum"-style file ("&lt;hex&gt;  FluentTimer.exe" or just the hex).</summary>
    public static string? ParseSha256(string text)
    {
        var token = text.Trim().Split([' ', '\t', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        return token is { Length: 64 } && token.All(Uri.IsHexDigit) ? token.ToLowerInvariant() : null;
    }
}
