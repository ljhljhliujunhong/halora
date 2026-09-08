# Halora

自己的 [Grok Build](https://x.ai) 桌面界面。打开它，选一个项目，就能直接跟 Grok 说话，不用盯着命令行。

中文名：星环。

## 需要什么

电脑里已经装好并登录过 Grok Build。Halora 调用的就是这份 Grok，能力没有另外阉过。

## 怎么跑

```bash
npm install
npm start
```

打包成 Windows 应用：

```bash
npm run pack
```

## 怎么用

1. 选一个项目文件夹。
2. 在下面的输入框里打字，回车发送。
3. 它要改文件或跑命令时，会先问你。
4. 左边按项目看对话，也可以同时开着几个窗口跑。

## 说明

这不是 xAI 官方产品。会话、登录、模型都走你本机的 `grok`。
