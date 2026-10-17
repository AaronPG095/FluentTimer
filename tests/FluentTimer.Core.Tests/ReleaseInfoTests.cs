using FluentTimer.Core;

namespace FluentTimer.Core.Tests;

public class ReleaseInfoTests
{
    private const string Base = "https://github.com/AaronPG095/FluentTimer/releases/download/v0.2.0/";

    private static string Json(string tag = "v0.2.0", bool pre = false, string exeUrl = Base + "FluentTimer.exe") => $$"""
        {
          "tag_name": "{{tag}}", "draft": false, "prerelease": {{(pre ? "true" : "false")}},
          "html_url": "https://github.com/AaronPG095/FluentTimer/releases/tag/{{tag}}",
          "body": "Notes",
          "assets": [
            { "name": "FluentTimer.exe", "browser_download_url": "{{exeUrl}}" },
            { "name": "FluentTimer.exe.sha256", "browser_download_url": "{{Base}}FluentTimer.exe.sha256" }
          ]
        }
        """;

    [Fact]
    public void Parses_latest_release()
    {
        var r = ReleaseInfo.TryParse(Json());
        Assert.NotNull(r);
        Assert.Equal(new Version(0, 2, 0), r.Version);
        Assert.EndsWith("FluentTimer.exe", r.ExeUrl);
        Assert.EndsWith(".sha256", r.Sha256Url);
        Assert.True(r.IsNewerThan(new Version(0, 1, 0, 0)));
        Assert.False(r.IsNewerThan(new Version(0, 2, 0)));
    }

    [Fact]
    public void Ignores_prereleases_and_foreign_download_hosts()
    {
        Assert.Null(ReleaseInfo.TryParse(Json(pre: true)));
        Assert.Null(ReleaseInfo.TryParse(Json(exeUrl: "https://evil.example.com/FluentTimer.exe")));
        Assert.Null(ReleaseInfo.TryParse(Json(exeUrl: "https://github.com/someone/else/releases/download/v1/FluentTimer.exe")));
        Assert.Null(ReleaseInfo.TryParse("not json"));
    }

    [Theory]
    [InlineData("v1.2.3", 1, 2, 3)]
    [InlineData("0.2", 0, 2, 0)]
    [InlineData("V2.0.1-beta", 2, 0, 1)]
    public void Parses_versions(string tag, int a, int b, int c)
    {
        Assert.True(ReleaseInfo.TryParseVersion(tag, out var v));
        Assert.Equal(new Version(a, b, c), v);
    }

    [Fact]
    public void Parses_sha256_files()
    {
        var hex = new string('a', 64);
        Assert.Equal(hex, ReleaseInfo.ParseSha256($"{hex.ToUpperInvariant()}  FluentTimer.exe\n"));
        Assert.Equal(hex, ReleaseInfo.ParseSha256(hex));
        Assert.Null(ReleaseInfo.ParseSha256("nope"));
    }
}
