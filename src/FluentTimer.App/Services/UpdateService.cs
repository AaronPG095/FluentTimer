using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using FluentTimer.Core;

namespace FluentTimer.App.Services;

/// <summary>
/// Checks GitHub Releases for a newer version and installs it: download, verify SHA-256, swap the exe, restart.
/// </summary>
internal sealed class UpdateService
{
    public const string AfterUpdateArg = "--after-update";
    private static readonly HttpClient Http = CreateClient();

    public static Version Current { get; } = typeof(UpdateService).Assembly.GetName().Version ?? new Version(0, 0, 0);

    public ReleaseInfo? Available { get; private set; }
    public string Status { get; private set; } = "";
    public bool Busy { get; private set; }

    public event Action? Changed;

    /// <summary>Self-update only makes sense for the published single-file exe, not a dev build.</summary>
    public static bool CanSelfUpdate =>
        !AppPaths.IsDev && Environment.ProcessPath is { } p &&
        Path.GetFileName(p).Equals(ReleaseInfo.ExeName, StringComparison.OrdinalIgnoreCase) &&
        !p.Contains(@"\bin\", StringComparison.OrdinalIgnoreCase);

    public async Task CheckAsync()
    {
        if (Busy) return;
        Set(busy: true, status: "Checking for updates…");
        try
        {
            var json = await Http.GetStringAsync(ReleaseInfo.LatestApi).ConfigureAwait(true);
            var release = ReleaseInfo.TryParse(json);
            Available = release is not null && release.IsNewerThan(Current) ? release : null;
            Set(busy: false, status: Available is { } r ? $"Version {r.Version} is available" : $"You're up to date ({Current.ToString(3)})");
        }
        catch (HttpRequestException e) when (e.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            Set(busy: false, status: "No releases published yet");
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            Set(busy: false, status: "Couldn't reach GitHub. Try again later");
        }
    }

    /// <summary>Downloads and verifies the new exe, swaps it in and restarts. Returns false (with Status) on failure.</summary>
    public async Task<bool> InstallAsync(Action releaseSingleInstance)
    {
        if (Available is not { } release || Busy || !CanSelfUpdate) return false;
        var exe = Environment.ProcessPath!;
        var dir = Path.GetDirectoryName(exe)!;
        var staged = Path.Combine(dir, "FluentTimer.new.exe");
        var old = Path.Combine(dir, "FluentTimer.old.exe");

        Set(busy: true, status: $"Downloading {release.Version}…");
        try
        {
            if (release.Sha256Url is null) return Fail("This release has no checksum; not installing it");
            var expected = ReleaseInfo.ParseSha256(await Http.GetStringAsync(release.Sha256Url).ConfigureAwait(true));
            if (expected is null) return Fail("The release checksum is unreadable");

            await using (var src = await Http.GetStreamAsync(release.ExeUrl).ConfigureAwait(true))
            await using (var dst = File.Create(staged))
                await src.CopyToAsync(dst).ConfigureAwait(true);

            string actual;
            await using (var check = File.OpenRead(staged))
                actual = Convert.ToHexString(await SHA256.HashDataAsync(check).ConfigureAwait(true)).ToLowerInvariant();
            if (actual != expected)
            {
                File.Delete(staged);
                return Fail("Download didn't match its checksum; not installed");
            }

            // A running exe can't be overwritten, but it can be renamed.
            if (File.Exists(old)) File.Delete(old);
            File.Move(exe, old);
            File.Move(staged, exe);

            releaseSingleInstance();
            Process.Start(new ProcessStartInfo(exe, $"{StartupRegistration.MinimizedArg} {AfterUpdateArg} {Environment.ProcessId}")
            {
                UseShellExecute = false,
                WorkingDirectory = dir,
            });
            return true;
        }
        catch (Exception e) when (e is HttpRequestException or IOException or UnauthorizedAccessException or TaskCanceledException)
        {
            // Roll back a half-done swap so the app keeps working.
            if (!File.Exists(exe) && File.Exists(old)) File.Move(old, exe);
            return Fail($"Update failed: {e.Message}");
        }
    }

    /// <summary>Called at startup: wait for the previous process to exit, then remove the old exe.</summary>
    public static void FinishPreviousUpdate(string[] args)
    {
        var i = Array.IndexOf(args, AfterUpdateArg);
        if (i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], out var pid))
        {
            try { Process.GetProcessById(pid).WaitForExit(10_000); }
            catch (ArgumentException) { /* already gone */ }
        }
        if (Environment.ProcessPath is not { } exe) return;
        var old = Path.Combine(Path.GetDirectoryName(exe)!, "FluentTimer.old.exe");
        for (var attempt = 0; attempt < 5 && File.Exists(old); attempt++)
        {
            try { File.Delete(old); }
            catch (IOException) { Thread.Sleep(400); }
            catch (UnauthorizedAccessException) { Thread.Sleep(400); }
        }
    }

    private bool Fail(string status)
    {
        Set(busy: false, status: status);
        return false;
    }

    private void Set(bool busy, string status)
    {
        Busy = busy;
        Status = status;
        Changed?.Invoke();
    }

    private static HttpClient CreateClient()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd($"FluentTimer/{Current.ToString(3)}");
        c.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return c;
    }
}
