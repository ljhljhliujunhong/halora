using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        string self = Path.GetFullPath(Application.ExecutablePath);
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;

        foreach (string candidate in Candidates(baseDir))
        {
            try
            {
                if (!File.Exists(candidate)) continue;
                string full = Path.GetFullPath(candidate);
                if (string.Equals(full, self, StringComparison.OrdinalIgnoreCase)) continue;
                StartApp(full);
                return;
            }
            catch
            {
            }
        }

        MessageBox.Show("还没有打包。先在项目目录运行 npm run pack。", "星环");
    }

    static IEnumerable<string> Candidates(string baseDir)
    {
        yield return Path.Combine(baseDir, "halora-app", "Halora.exe");
        yield return Path.Combine(baseDir, "Halora.exe");
    }

    static void StartApp(string app)
    {
        ProcessStartInfo psi = new ProcessStartInfo
        {
            FileName = app,
            WorkingDirectory = Path.GetDirectoryName(app),
            UseShellExecute = false
        };
        psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        psi.EnvironmentVariables.Remove("SMOKE_TEST");
        Process.Start(psi);
    }
}
