using System;
using System.Windows;

namespace SimorghSetup
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            var window = new SetupWindow();

            // --screens <folder>: draw every screen to a PNG and stop. The build
            // runs this so what the setup looks like can be checked without
            // clicking through it.
            int i = Array.FindIndex(args, a => a.Equals("--screens", StringComparison.OrdinalIgnoreCase));
            if (i >= 0 && i + 1 < args.Length)
            {
                window.SaveScreens(args[i + 1]);
                return 0;
            }
            return app.Run(window);
        }
    }
}
