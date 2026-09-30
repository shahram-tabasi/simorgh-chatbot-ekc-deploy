// What installing does, apart from the screens: unpack the app carried inside
// this .exe, put the uninstaller beside it, make the shortcuts and register it
// in Apps & features. Also takes out an older installation first — including
// one made by the earlier NSIS installer — so the two never sit side by side.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Threading;
using Microsoft.Win32;
using Simorgh;

namespace SimorghSetup
{
    internal sealed class Component
    {
        public string Id;
        public string Title;
        public string Description;
        public string Icon;          // which glyph the list draws
        public bool Required;
        public bool Selected = true;
        public long Bytes;
    }

    internal sealed class InstallEngine
    {
        // The local database engine is the one part of the app that can be
        // left out: without it the app can still use a MongoDB server.
        private const string MongoPrefix = "resources/bundle/mongo/";

        public readonly List<Component> Components;
        public string Version { get; }
        public bool HasPayload { get; }

        public InstallEngine()
        {
            Version = Assembly.GetExecutingAssembly()
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Split('+')[0] ?? "";
            long core = 0, mongo = 0;
            using (var zip = OpenPayload())
            {
                HasPayload = zip != null;
                if (zip != null)
                    foreach (var e in zip.Entries)
                        if (IsMongo(e)) mongo += e.Length; else core += e.Length;
            }
            Components = new List<Component>
            {
                new Component { Id = "core", Title = "Simorgh Design Suite Core", Description = "Main application and core features", Icon = "logo", Required = true, Bytes = core },
                new Component { Id = "mongo", Title = "Local Database Engine", Description = "MongoDB, so projects can be kept on this computer", Icon = "db", Bytes = mongo },
                new Component { Id = "desktop", Title = "Desktop Shortcut", Description = "Start the suite from the desktop", Icon = "link" },
                new Component { Id = "startmenu", Title = "Start Menu Shortcut", Description = "Find the suite in the Start menu", Icon = "menu" },
            };
        }

        public bool Selected(string id) => Components.First(c => c.Id == id).Selected;

        public long TotalBytes => Components.Where(c => c.Selected).Sum(c => c.Bytes);

        private static bool IsMongo(ZipArchiveEntry e) =>
            e.FullName.Replace('\\', '/').StartsWith(MongoPrefix, StringComparison.OrdinalIgnoreCase);

        private static ZipArchive OpenPayload()
        {
            var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
            return s == null ? null : new ZipArchive(s, ZipArchiveMode.Read);
        }

        public string ExePath => Path.Combine(Product.InstallDir, Product.ExeName);

        /// <summary>Processes that have to stop before the files can be replaced.</summary>
        public static Process[] Blocking()
        {
            // The app from anywhere (an NSIS-installed one lives elsewhere),
            // and the database it started from our folder.
            var byName = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Product.ExeName));
            return byName.Concat(Product.RunningFrom(Product.InstallDir)).GroupBy(p => p.Id).Select(g => g.First()).ToArray();
        }

        /// <summary>
        /// Install. <paramref name="step"/> gets 0‥3 as each of the four steps
        /// starts, <paramref name="progress"/> 0‥1 overall.
        /// </summary>
        public void Run(Action<int> step, Action<double> progress, CancellationToken cancel)
        {
            if (!HasPayload) throw new InvalidOperationException("This setup program carries no application. It was built without its payload.");
            var dir = Product.InstallDir;

            // 1. Copying files
            step(0);
            Product.Stop(Blocking());
            RemoveOlderInstallers();
            if (Directory.Exists(dir)) ClearFolder(dir);
            Directory.CreateDirectory(dir);

            using (var zip = OpenPayload())
            {
                var entries = zip.Entries.Where(e => !string.IsNullOrEmpty(e.Name))
                    .Where(e => Selected("mongo") || !IsMongo(e)).ToList();
                long total = Math.Max(1, entries.Sum(e => e.Length)), done = 0;
                var root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
                var buffer = new byte[1 << 16];
                foreach (var e in entries)
                {
                    cancel.ThrowIfCancellationRequested();
                    var target = Path.GetFullPath(Path.Combine(dir, e.FullName.Replace('/', '\\')));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue; // never outside the folder
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (var from = e.Open())
                    using (var to = File.Create(target))
                    {
                        int n;
                        while ((n = from.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            to.Write(buffer, 0, n);
                            done += n;
                            progress(0.9 * done / total);
                        }
                    }
                    File.SetLastWriteTime(target, e.LastWriteTime.DateTime);
                }
            }

            // 2. Installing features
            step(1);
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("uninstall.exe"))
            {
                if (s != null)
                    using (var to = File.Create(Path.Combine(dir, Product.UninstallerName))) s.CopyTo(to);
            }
            progress(0.93);

            // 3. Configuring application
            step(2);
            Product.DeleteQuietly(Product.DesktopShortcut);
            Product.DeleteQuietly(Product.StartMenuShortcut);
            if (Selected("desktop")) Product.CreateShortcut(Product.DesktopShortcut, ExePath, Product.Name);
            if (Selected("startmenu")) Product.CreateShortcut(Product.StartMenuShortcut, ExePath, Product.Name);
            Register(dir);
            progress(0.97);

            // 4. Finalizing installation
            step(3);
            progress(1);
        }

        private void Register(string dir)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(Product.UninstallKey))
            {
                var uninstaller = Path.Combine(dir, Product.UninstallerName);
                k.SetValue("DisplayName", Product.Name);
                k.SetValue("DisplayVersion", Version);
                k.SetValue("Publisher", Product.Publisher);
                k.SetValue("DisplayIcon", ExePath + ",0");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", $"\"{uninstaller}\"");
                k.SetValue("QuietUninstallString", $"\"{uninstaller}\" /S");
                k.SetValue("EstimatedSize", (int)(TotalBytes / 1024), RegistryValueKind.DWord);
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            }
        }

        // The earlier installer (NSIS, from electron-builder) registered the
        // app under its own key and folder. Its uninstaller, run quietly,
        // removes both; the settings and the database are in the user's data
        // folder, which it leaves alone.
        private static void RemoveOlderInstallers()
        {
            const string root = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
            using (var uninstall = Registry.CurrentUser.OpenSubKey(root))
            {
                if (uninstall == null) return;
                foreach (var name in uninstall.GetSubKeyNames())
                {
                    if (name.Equals("SimorghDesignSuite", StringComparison.OrdinalIgnoreCase)) continue;
                    using (var k = uninstall.OpenSubKey(name))
                    {
                        var display = k?.GetValue("DisplayName") as string ?? "";
                        if (!display.StartsWith(Product.Name, StringComparison.OrdinalIgnoreCase)) continue;
                        var quiet = k.GetValue("QuietUninstallString") as string;
                        var plain = k.GetValue("UninstallString") as string;
                        var command = !string.IsNullOrEmpty(quiet) ? quiet
                            : !string.IsNullOrEmpty(plain) ? plain + " /S" : null;
                        if (command == null) continue;
                        try
                        {
                            var (exe, args) = SplitCommand(command);
                            if (!File.Exists(exe)) continue;
                            using (var p = Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true }))
                                p?.WaitForExit(120000);
                        }
                        catch { /* an old version left behind is not a reason to fail */ }
                    }
                }
            }
        }

        private static (string exe, string args) SplitCommand(string command)
        {
            command = command.Trim();
            if (command.StartsWith("\""))
            {
                var end = command.IndexOf('"', 1);
                return (command.Substring(1, end - 1), command.Substring(end + 1).Trim());
            }
            var exeEnd = command.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
            if (exeEnd < 0) return (command, "");
            return (command.Substring(0, exeEnd + 4), command.Substring(exeEnd + 4).Trim());
        }

        private static void ClearFolder(string dir)
        {
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    foreach (var f in Directory.GetFiles(dir)) File.Delete(f);
                    foreach (var d in Directory.GetDirectories(dir)) Directory.Delete(d, true);
                    return;
                }
                catch (Exception) when (attempt < 10)
                {
                    Thread.Sleep(500); // a process that was just stopped can hold its files a moment longer
                }
            }
        }

        public void Launch()
        {
            try
            {
                Process.Start(new ProcessStartInfo(ExePath) { UseShellExecute = true, WorkingDirectory = Product.InstallDir });
            }
            catch { /* the shortcut still works */ }
        }

        public static string Size(long bytes)
        {
            if (bytes <= 0) return "—";
            if (bytes >= 1L << 30) return $"{bytes / (double)(1L << 30):0.00} GB";
            return $"{Math.Max(1, bytes / (1L << 20))} MB";
        }
    }
}
