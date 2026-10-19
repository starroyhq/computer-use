using System.Text.RegularExpressions;

namespace ComputerUse.WindowsHost;

internal sealed record AgentProfile(string Name, string State);
internal sealed record AgentHost(string State);
internal sealed record AgentPreflight(int SchemaVersion, string Version, string Platform, AgentHost Host,
    string[] Profiles, AgentProfile Profile);

internal interface IAgentCommand
{
    Task<AgentPreflight> PreflightAsync(string profile, CancellationToken cancellation);
    /// <summary>profile 为 null 时不写死名称，由当前 Agent 自行选择。</summary>
    Task<string> SetupPromptAsync(string? profile, CancellationToken cancellation);
}

/// <summary>不读取凭据文件；由包内 CLI 验证 profile 并生成安装提示词。</summary>
internal sealed class AgentCommand(PackageCommand command) : IAgentCommand
{
    internal static bool ValidProfile(string value) => Regex.IsMatch(value, "\\A[a-zA-Z0-9_-]{1,64}\\z", RegexOptions.CultureInvariant);

    public async Task<AgentPreflight> PreflightAsync(string profile, CancellationToken cancellation)
    {
        ValidateProfile(profile);
        var result = await command.RunJsonAsync<AgentPreflight>(["preflight", "--profile", profile], cancellation);
        if (result.SchemaVersion != 1 || string.IsNullOrEmpty(result.Version) || string.IsNullOrEmpty(result.Platform)
            || result.Host is null || string.IsNullOrEmpty(result.Host.State) || result.Profiles is null
            || result.Profiles.Any(value => value is null || !ValidProfile(value)) || result.Profile is null
            || result.Profile.Name != profile || result.Profile.State is not ("missing" or "invalid" or "unverified" or "valid" or "unauthorized"))
            throw new UpdateFailure("output", "");
        return result;
    }

    public async Task<string> SetupPromptAsync(string? profile, CancellationToken cancellation)
    {
        if (profile is not null) ValidateProfile(profile);
        string[] arguments = profile is null ? ["skill", "prompt"] : ["skill", "prompt", "--profile", profile];
        var text = await command.RunAsync(arguments, cancellation);
        if (string.IsNullOrWhiteSpace(text)) throw new UpdateFailure("output", "");
        return text;
    }

    private static void ValidateProfile(string value)
    {
        if (!ValidProfile(value)) throw new ArgumentException("Invalid profile name.", nameof(value));
    }
}
