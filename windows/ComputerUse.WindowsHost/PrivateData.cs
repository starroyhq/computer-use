using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace ComputerUse.WindowsHost;

internal static class PrivateData
{
    internal static readonly string DirectoryPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Computer Use");
    internal static readonly string DiscoveryPath = Path.Combine(DirectoryPath, "runtime-pipe.json");

    internal static void EnsureDirectory()
    {
        var directory = new DirectoryInfo(DirectoryPath);
        directory.Create();
        var current = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Cannot identify current user.");
        SecureDirectory(directory, current);
    }

    private static void SecureDirectory(DirectoryInfo directory, SecurityIdentifier current)
    {
        directory.Refresh();
        if (directory.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new IOException("Computer Use data directory must not contain reparse points.");
        var existing = directory.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        if (!current.Equals(existing.GetOwner(typeof(SecurityIdentifier))))
            throw new UnauthorizedAccessException("Computer Use data directory is not owned by the current user.");

        var access = new DirectorySecurity();
        access.SetOwner(current);
        access.SetAccessRuleProtection(true, false);
        access.AddAccessRule(new FileSystemAccessRule(current, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        directory.SetAccessControl(access);

        // A protected parent ACL does not rewrite older files' explicit ACLs.
        // This also covers credential exports, action logs, and browser downloads.
        foreach (var entry in directory.EnumerateFileSystemInfos())
        {
            if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new IOException("Computer Use data directory must not contain reparse points.");
            if (entry is DirectoryInfo child) SecureDirectory(child, current);
            else if (entry is FileInfo file) SecureFile(file, current);
        }
    }

    private static void SecureFile(FileInfo file, SecurityIdentifier current)
    {
        var existing = file.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        if (!current.Equals(existing.GetOwner(typeof(SecurityIdentifier))))
            throw new UnauthorizedAccessException("Computer Use state file is not owned by the current user.");
        var access = new FileSecurity();
        access.SetOwner(current);
        access.SetAccessRuleProtection(true, false);
        access.AddAccessRule(new FileSystemAccessRule(current, FileSystemRights.FullControl, AccessControlType.Allow));
        file.SetAccessControl(access);
    }

    internal static void WriteDiscovery(string pipeName)
    {
        if (File.Exists(DiscoveryPath) && File.GetAttributes(DiscoveryPath).HasFlag(FileAttributes.ReparsePoint))
            throw new IOException("Pipe discovery file must not be a reparse point.");

        var temporary = Path.Combine(DirectoryPath, $"runtime-pipe.{Guid.NewGuid():N}.tmp");
        try
        {
            // The parent ACL is protected and inheritable. A new file inherits
            // its current-user-only DACL; the write-only stream handle does not
            // have WRITE_DAC rights for SetAccessControl.
            using (var stream = new FileStream(temporary, new FileStreamOptions
            {
                Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None,
                Options = FileOptions.WriteThrough
            }))
            {
                JsonSerializer.Serialize(stream, new { pipeName });
                stream.Flush(true);
            }
            File.Move(temporary, DiscoveryPath, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    internal static void RemoveDiscovery(string pipeName)
    {
        try
        {
            if (File.GetAttributes(DiscoveryPath).HasFlag(FileAttributes.ReparsePoint)) return;
            using var document = JsonDocument.Parse(File.ReadAllText(DiscoveryPath));
            if (document.RootElement.TryGetProperty("pipeName", out var value) && value.GetString() == pipeName)
                File.Delete(DiscoveryPath);
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (JsonException) { }
        catch (UnauthorizedAccessException) { }
        catch (IOException) { }
    }
}
