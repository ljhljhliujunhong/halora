using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string marker = Path.Combine(root, ".halora-update.json");
        if (File.Exists(marker))
        {
            try {
                var tx = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(marker));
                var helper = new ProcessStartInfo((string)tx["node"], "\"" + (string)tx["helper"] + "\" \"" + marker + "\"") { UseShellExecute = false, CreateNoWindow = true };
                helper.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                Process.Start(helper);
                for (int i = 0; i < 300 && File.Exists(marker); i++) Thread.Sleep(100);
                if (File.Exists(marker)) {
                    string error = marker + ".error";
                    MessageBox.Show(File.Exists(error) ? "更新尚未完成：" + File.ReadAllText(error) : "正在更新 Halora，请稍后再打开。", "Halora");
                    return;
                }
            } catch (Exception error) { MessageBox.Show("无法完成更新：" + error.Message, "Halora"); return; }
        }

        string app = Path.Combine(root, "runtime", "app", "Halora.exe");
        // Compatibility fallback is only used if migration to the single-directory layout has not completed.
        if (!File.Exists(app))
        {
            try {
                string pointer = Path.Combine(root, "runtime", "current.json");
                if (File.Exists(pointer)) {
                    var selected = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(pointer));
                    string candidate = (string)selected["directory"];
                    if (candidate != Path.GetFileName(candidate) || candidate.IndexOfAny(new char[] { '/', '\\', ':' }) >= 0) throw new Exception("旧版路径无效");
                    app = Path.Combine(root, "runtime", "versions", candidate, "Halora.exe");
                }
            } catch (Exception error) { MessageBox.Show("无法读取当前版本：" + error.Message, "Halora"); return; }
        }
        if (!File.Exists(app)) { MessageBox.Show("还没有安装 Halora，请运行 npm run pack。", "Halora"); return; }
        try {
            var start = new ProcessStartInfo(app) { WorkingDirectory = Path.GetDirectoryName(app), UseShellExecute = false };
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            start.EnvironmentVariables.Remove("SMOKE_TEST");
            start.EnvironmentVariables["HALORA_INSTALL_ROOT"] = root;
            Process.Start(start);
        } catch (Exception error) { MessageBox.Show(error.Message, "Halora"); }
    }
}
