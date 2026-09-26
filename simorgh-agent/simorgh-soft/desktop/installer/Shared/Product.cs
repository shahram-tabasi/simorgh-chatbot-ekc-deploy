// What the installer and the uninstaller both need to know about the product:
// where it goes, what it is called, how it is registered, and how to find it
// running. One copy, compiled into both.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.Win32;

namespace Simorgh
{
    internal static class Product
    {
        public const string Name = "Simorgh Design Suite";
        public const string Publisher = "Simorgh Technology";
        public const string ExeName = "Simorgh Design Suite.exe";
        public const string UninstallerName = "Uninstall Simorgh Design Suite.exe";
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\SimorghDesignSuite";

        // Per user, like the installer it replaces: no administrator needed,
        // and an update lands in the same place.
        public static string InstallDir => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name);

        // Electron's userData: settings, the local database, the logs. Kept on
        // uninstall unless the person asks for it to go.
        public static string DataDir => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Name);

        public static string DesktopShortcut => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Name + ".lnk");

        public static string StartMenuShortcut => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name + ".lnk");

        /// <summary>The app's processes (and the database it starts) running from <paramref name="dir"/>.</summary>
        public static Process[] RunningFrom(string dir)
        {
            var prefix = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            return Process.GetProcessesByName(Path.GetFileNameWithoutExtension(ExeName))
                .Concat(Process.GetProcessesByName("mongod"))
                .Where(p =>
                {
                    try { return p.MainModule.FileName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase); }
                    catch { return false; }
                })
                .ToArray();
        }

        public static void Stop(Process[] processes)
        {
            foreach (var p in processes)
            {
                try { p.Kill(); p.WaitForExit(10000); } catch { /* already gone */ }
            }
        }

        public static void CreateShortcut(string lnk, string target, string description)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(lnk));
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell = Activator.CreateInstance(shellType);
            try
            {
                dynamic link = shell.CreateShortcut(lnk);
                link.TargetPath = target;
                link.WorkingDirectory = Path.GetDirectoryName(target);
                link.IconLocation = target + ",0";
                link.Description = description;
                link.Save();
            }
            finally
            {
                System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
            }
        }

        public static void DeleteQuietly(string file)
        {
            try { if (File.Exists(file)) File.Delete(file); } catch { /* best effort */ }
        }

        public static void Unregister()
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { /* best effort */ }
        }
    }
}
