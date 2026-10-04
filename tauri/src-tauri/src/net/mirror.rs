//! BMCL 镜像改写：与 Electron 版 mirror.js 一致。

use crate::config;

const REPLACEMENTS: [(&str, &str); 6] = [
    ("https://launchermeta.mojang.com", "https://bmclapi2.bangbang93.com"),
    ("https://piston-meta.mojang.com", "https://bmclapi2.bangbang93.com"),
    ("https://piston-data.mojang.com", "https://bmclapi2.bangbang93.com"),
    ("https://libraries.minecraft.net", "https://bmclapi2.bangbang93.com/maven"),
    ("https://resources.download.minecraft.net", "https://bmclapi2.bangbang93.com/assets"),
    ("https://launcher.mojang.com", "https://bmclapi2.bangbang93.com"),
];

/// 开了 bmcl 镜像才改写，命中前缀即替换（对齐 JS 的 startsWith + break）
pub fn mirror_url(url: &str) -> String {
    if config::get("mirror").as_str() != Some("bmcl") {
        return url.to_string();
    }
    for (from, to) in REPLACEMENTS {
        if let Some(rest) = url.strip_prefix(from) {
            return format!("{to}{rest}");
        }
    }
    url.to_string()
}
