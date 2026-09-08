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

        MessageBox.Show("找不到 Halora。", "Halora");
    }

    static IEnumerable<string> Candidates(string baseDir)
    {
        yield return Path.Combine(baseDir, "Halora.exe");
        yield return Path.Combine(baseDir, "Xinghuan.exe");
        yield return Path.Combine(baseDir, "Gongfang.exe");
        yield return Path.Combine(baseDir, "halora-app", "Halora.exe");
        yield return Path.Combine(baseDir, "xinghuan-app", "Xinghuan.exe");
        yield return Path.Combine(baseDir, "gongfang-app", "Xinghuan.exe");
        yield return Path.Combine(baseDir, "gongfang-app", "Gongfang.exe");

        string projects = @"E:\VsCodeProject";
        if (Directory.Exists(projects))
        {
            string[] dirs = new string[0];
            try { dirs = Directory.GetDirectories(projects); }
            catch { dirs = new string[0]; }
            foreach (string dir in dirs)
            {
                yield return Path.Combine(dir, "halora-app", "Halora.exe");
                yield return Path.Combine(dir, "xinghuan-app", "Xinghuan.exe");
                yield return Path.Combine(dir, "gongfang-app", "Xinghuan.exe");
                yield return Path.Combine(dir, "gongfang-app", "Gongfang.exe");
            }
        }
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
