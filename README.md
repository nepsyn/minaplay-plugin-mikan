[![MinaPlay Logo](https://github.com/nepsyn/minaplay/blob/master/assets/minaplay.png)](https://github.com/nepsyn/minaplay)

# minaplay-plugin-mikan

[MinaPlay](https://github.com/nepsyn/minaplay) 的蜜柑计划插件支持，可以在 MinaPlay 中添加蜜柑计划中的番剧。

## 安装

### 插件管理器安装

使用 MinaPlay 插件管理器安装，在启用 `plugin-manager` 插件的情况下，在控制台输入：

```shell
pm i mikan
```

### 本地安装

```shell
# 进入 MinaPlay 插件数据目录
cd minaplay-app-data/plugin
# 克隆仓库到本地
git clone https://github.com/nepsyn/minaplay-plugin-mikan
cd minaplay-plugin-mikan
npm install --omit=peer
# 重启 MinaPlay 应用程序应用插件
docker restart minaplay
```

## 使用

### 帮助信息

通过命令打印使用时的帮助信息。

```shell
mikan --help
```

### 设置 mikan 站点 url

通过命令设置蜜柑计划源站点。

```shell
mikan set-base https://mikanime.tv
```

### 设置 mikan 图片代理服务地址

通过命令设置蜜柑计划图片代理服务地址。

```shell
mikan set-image-proxy https://xxx.dev.workers
```

设置后所有的图片将通过代理服务器：

https://mikanani.me/images/Bangumi/202407/b545df05.jpg

->

https://xxx.dev.workers?url=https://mikanani.me/images/Bangumi/202407/b545df05.jpg
