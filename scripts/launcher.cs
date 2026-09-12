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
        var paths = new List<string>
        {
            Path.Combine(baseDir, "halora-app", "Halora.exe"),
            Path.Combine(baseDir, "pack-out", "win-unpacked", "Halora.exe"),
            Path.Combine(baseDir, "release", "win-unpacked", "Halora.exe"),
            Path.Combine(baseDir, "Halora.exe"),
        };
        paths.Sort((a, b) =>
        {
            DateTime ta = File.Exists(a) ? File.GetLastWriteTimeUtc(a) : DateTime.MinValue;
            DateTime tb = File.Exists(b) ? File.GetLastWriteTimeUtc(b) : DateTime.MinValue;
            int cmp = tb.CompareTo(ta);
            if (cmp != 0) return cmp;
            bool aHome = a.IndexOf("halora-app", StringComparison.OrdinalIgnoreCase) >= 0;
            bool bHome = b.IndexOf("halora-app", StringComparison.OrdinalIgnoreCase) >= 0;
            if (aHome == bHome) return 0;
            return aHome ? -1 : 1;
        });
        foreach (string path in paths) yield return path;
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
