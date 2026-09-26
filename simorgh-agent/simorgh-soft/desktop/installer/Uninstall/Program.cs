// Uninstall Simorgh Design Suite.exe — copied into the install folder by the
// setup program and registered in Apps & features.
//
// Removes the program, its shortcuts and its registration. The projects
// database and the settings are the person's work, not the program: they are
// kept unless the person says to remove them too.
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Simorgh;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool quiet = Array.Exists(args, a => a.Equals("/S", StringComparison.OrdinalIgnoreCase));
        string dir = Path.GetDirectoryName(Application.ExecutablePath);

        if (!quiet && MessageBox.Show(
                $"Remove {Product.Name} from this computer?",
                $"Uninstall {Product.Name}", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            return 1;

        bool removeData = !quiet && Directory.Exists(Product.DataDir) && MessageBox.Show(
            "Also remove your projects database and settings?\n\n" +
            $"They are in {Product.DataDir}. Choose No to keep them for a later installation.",
            $"Uninstall {Product.Name}", MessageBoxButtons.YesNo, MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2) == DialogResult.Yes;

        var running = Product.RunningFrom(dir);
        if (running.Length > 0)
        {
            if (!quiet && MessageBox.Show($"{Product.Name} is running. Close it and continue?",
                    $"Uninstall {Product.Name}", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK)
                return 1;
            Product.Stop(running);
        }

        Product.DeleteQuietly(Product.DesktopShortcut);
        Product.DeleteQuietly(Product.StartMenuShortcut);
        Product.Unregister();

        if (removeData)
        {
            try { Directory.Delete(Product.DataDir, true); } catch { /* in use: left behind */ }
        }

        // This program runs from the folder it removes, so the folder goes a
        // moment after it has exited.
        Process.Start(new ProcessStartInfo("cmd.exe",
            $"/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"{dir}\"")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
            WindowStyle = ProcessWindowStyle.Hidden,
        });

        if (!quiet)
            MessageBox.Show($"{Product.Name} has been removed from this computer.",
                $"Uninstall {Product.Name}", MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }
}
