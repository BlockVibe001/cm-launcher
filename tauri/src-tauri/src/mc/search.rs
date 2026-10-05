//! 资源中心：Modrinth / CurseForge 搜索与下载。
//! 对齐 Electron 版 minecraft/modrinth.js + curseforge.js。

use crate::config;
use crate::error::{AppError, CmdResult};
use reqwest::Client;
use serde_json::{json, Value};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

const MR_OFFICIAL: &str = "https://api.modrinth.com/v2";
const MR_MCIM: &str = "https://mod.mcimirror.top/modrinth/v2";
const CF_API: &str = "https://api.curseforge.com/v1";

fn http() -> Client {
    Client::builder()
        .use_native_tls()
        .user_agent("CM-Launcher (https://github.com/cm)")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

fn mirror_url(url: &str) -> String {
    if config::get("mirror").as_str() != Some("bmcl") {
        return url.to_string();
    }
    let rep: [(&str, &str); 6] = [
        ("https://launchermeta.mojang.com", "https://bmclapi2.bangbang93.com"),
        ("https://piston-meta.mojang.com", "https://bmclapi2.bangbang93.com"),
        ("https://piston-data.mojang.com", "https://bmclapi2.bangbang93.com"),
        ("https://libraries.minecraft.net", "https://bmclapi2.bangbang93.com/maven"),
        ("https://resources.download.minecraft.net", "https://bmclapi2.bangbang93.com/assets"),
        ("https://launcher.mojang.com", "https://bmclapi2.bangbang93.com"),
    ];
    for (from, to) in rep {
        if url.starts_with(from) {
            return format!("{}{}", to, &url[from.len()..]);
        }
    }
    url.to_string()
}

fn mr_bases() -> Vec<&'static str> {
    if config::get("mirror").as_str() == Some("bmcl") {
        vec![MR_MCIM, MR_OFFICIAL]
    } else {
        vec![MR_OFFICIAL, MR_MCIM]
    }
}

async fn mr_fetch(path: &str) -> Result<Value, AppError> {
    let mut last_err = String::new();
    for base in mr_bases() {
        let url = format!("{base}{path}");
        match http().get(&url).send().await {
            Ok(r) if r.status().is_success() => match r.json::<Value>().await {
                Ok(v) => return Ok(v),
                Err(e) => last_err = e.to_string(),
            },
            Ok(r) => last_err = format!("HTTP {}", r.status()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(AppError::Msg(format!("Modrinth 请求失败：{last_err}")))
}

/* ============== Modrinth ============== */

pub async fn modrinth_search(
    query: &str,
    mc_version: &str,
    mod_loader: &str,
    project_type: &str,
) -> CmdResult<Value> {
    let build_facets = |with_version: bool| -> String {
        let mut f: Vec<String> = vec![format!(r#"["project_type:{project_type}"]"#)];
        if with_version && !mc_version.is_empty() {
            f.push(format!(r#"["versions:{mc_version}"]"#));
        }
        if !mod_loader.is_empty() && mod_loader != "vanilla" {
            f.push(format!(r#"["categories:{mod_loader}"]"#));
        }
        format!("[{}]", f.join(","))
    };

    async fn do_search(query: &str, facets: &str) -> CmdResult<Value> {
        let qs = serde_urlencoded::to_string([
            ("query", query),
            ("limit", "20"),
            ("facets", facets),
        ])
        .unwrap_or_default();
        mr_fetch(&format!("/search?{qs}")).await
    }

    let mut data = do_search(query, &build_facets(true)).await?;
    let total = data.get("total_hits").and_then(|v| v.as_u64()).unwrap_or(0);
    if !mc_version.is_empty() && total == 0 {
        data = do_search(query, &build_facets(false)).await?;
    }

    let hits = data.get("hits").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let out: Vec<Value> = hits
        .into_iter()
        .map(|h| {
            json!({
                "id": h.get("project_id").or(h.get("slug")).and_then(|v| v.as_str()).unwrap_or(""),
                "name": h.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "slug": h.get("slug").and_then(|v| v.as_str()).unwrap_or(""),
                "summary": h.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                "author": h.get("author").and_then(|v| v.as_str()).unwrap_or(""),
                "downloadCount": h.get("downloads").unwrap_or(&Value::Null),
                "icon": h.get("icon_url").and_then(|v| v.as_str()).unwrap_or(""),
                "categories": h.get("categories").cloned().unwrap_or(Value::Array(vec![])),
                "versions": h.get("versions").cloned().unwrap_or(Value::Array(vec![])),
                "follows": h.get("follows").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(Value::Array(out))
}

pub async fn modrinth_versions(
    project_id: &str,
    mc_version: &str,
    mod_loader: &str,
) -> CmdResult<Value> {
    let fetch = |with_version: bool| async move {
        let mut p: Vec<(&str, String)> = Vec::new();
        if with_version && !mc_version.is_empty() {
            p.push(("game_versions", serde_json::to_string(&[mc_version]).unwrap_or_default()));
        }
        if !mod_loader.is_empty() && mod_loader != "vanilla" {
            p.push(("loaders", serde_json::to_string(&[mod_loader]).unwrap_or_default()));
        }
        let qs = serde_urlencoded::to_string(&p).unwrap_or_default();
        mr_fetch(&format!("/project/{project_id}/version?{qs}")).await
    };
    let mut data = fetch(true).await?;
    let arr = data.as_array().cloned().unwrap_or_default();
    if !mc_version.is_empty() && arr.is_empty() {
        data = fetch(false).await?;
    }
    let list = data.as_array().cloned().unwrap_or_default();
    let mut out: Vec<Value> = list
        .into_iter()
        .map(|v| {
            let files: Vec<Value> = v
                .get("files")
                .and_then(|f| f.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|f| {
                    json!({
                        "name": f.get("filename").and_then(|x| x.as_str()).unwrap_or(""),
                        "size": f.get("size").unwrap_or(&Value::Null),
                        "url": f.get("url").and_then(|x| x.as_str()).unwrap_or(""),
                        "primary": f.get("primary").unwrap_or(&Value::Bool(false)),
                    })
                })
                .collect();
            json!({
                "id": v.get("id").and_then(|x| x.as_str()).unwrap_or(""),
                "name": v.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                "versionNumber": v.get("version_number").and_then(|x| x.as_str()).unwrap_or(""),
                "files": files,
                "gameVersions": v.get("game_versions").cloned().unwrap_or(Value::Array(vec![])),
                "loaders": v.get("loaders").cloned().unwrap_or(Value::Array(vec![])),
                "datePublished": v.get("date_published").and_then(|x| x.as_str()).unwrap_or(""),
                "dependencies": v.get("dependencies").cloned().unwrap_or(Value::Array(vec![])),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.get("datePublished")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .cmp(a.get("datePublished").and_then(|x| x.as_str()).unwrap_or(""))
    });
    Ok(Value::Array(out))
}

pub async fn modrinth_project(project_id: &str) -> CmdResult<Value> {
    let p = mr_fetch(&format!("/project/{project_id}")).await?;
    Ok(json!({
        "id": p.get("id").or(p.get("slug")).and_then(|v| v.as_str()).unwrap_or(""),
        "title": p.get("title").and_then(|v| v.as_str()).unwrap_or(""),
        "slug": p.get("slug").and_then(|v| v.as_str()).unwrap_or(""),
        "icon": p.get("icon_url").and_then(|v| v.as_str()).unwrap_or(""),
    }))
}

pub async fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    let resp = http()
        .get(mirror_url(url))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("下载失败 HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = fs::File::create(dest).map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

const TYPE_DIRS: &[(&str, &str)] = &[
    ("mod", "mods"),
    ("shader", "shaderpacks"),
    ("resourcepack", "resourcepacks"),
    ("datapack", "datapacks"),
    ("modpack", ".modpacks"),
];

pub async fn modrinth_download(file: &Value, game_dir: &str, project_type: &str) -> CmdResult<String> {
    let name = file.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let url = file.get("url").and_then(|v| v.as_str()).unwrap_or("");
    if url.is_empty() {
        return Err(AppError::Msg("文件缺少下载链接".into()));
    }
    let sub = TYPE_DIRS
        .iter()
        .find(|(k, _)| *k == project_type)
        .map(|(_, v)| *v)
        .unwrap_or("downloads");
    let dest = Path::new(game_dir).join(sub).join(name);
    download_file(url, &dest).await.map_err(AppError::Msg)?;
    Ok(dest.to_string_lossy().to_string())
}

/* ============== CurseForge ============== */

const CF_CLASS_IDS: &[(&str, &str)] = &[
    ("mod", "6"),
    ("world", "17"),
    ("resourcepack", "12"),
    ("modpack", "4479"),
];

pub async fn curseforge_search(
    query: &str,
    mc_version: &str,
    mod_loader: &str,
    cls: &str,
) -> CmdResult<Value> {
    let class_id = CF_CLASS_IDS
        .iter()
        .find(|(k, _)| *k == cls)
        .map(|(_, v)| *v)
        .unwrap_or("6");
    let mut params: Vec<(&str, String)> = vec![
        ("gameId", "432".into()),
        ("classId", class_id.into()),
        ("searchFilter", query.into()),
        ("pageSize", "20".into()),
        ("sortField", "2".into()),
        ("sortOrder", "desc".into()),
    ];
    if !mc_version.is_empty() {
        params.push(("gameVersion", mc_version.into()));
    }
    if cls == "mod" && !mod_loader.is_empty() && mod_loader != "vanilla" {
        let lt = match mod_loader {
            "forge" => "1",
            "fabric" => "4",
            "quilt" => "5",
            _ => "",
        };
        if !lt.is_empty() {
            params.push(("modLoaderType", lt.into()));
        }
    }
    let qs = serde_urlencoded::to_string(&params).unwrap_or_default();
    let resp = http()
        .get(format!("{CF_API}/mods/search?{qs}"))
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    if resp.status() == 403 {
        return Err(AppError::Msg("CurseForge 接口需要 API Key（403），请改用 Modrinth".into()));
    }
    if !resp.status().is_success() {
        return Err(AppError::Msg(format!(
            "CurseForge 搜索失败 (HTTP {})",
            resp.status()
        )));
    }
    let data: Value = resp.json().await.map_err(|e| AppError::Msg(e.to_string()))?;
    let arr = data.get("data").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let out: Vec<Value> = arr
        .into_iter()
        .map(|m| {
            let authors: Vec<String> = m
                .get("authors")
                .and_then(|a| a.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|a| a.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .collect();
            json!({
                "id": m.get("id").unwrap_or(&Value::Null),
                "name": m.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "slug": m.get("slug").and_then(|v| v.as_str()).unwrap_or(""),
                "summary": m.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
                "authors": authors.join(", "),
                "downloadCount": m.get("downloadCount").unwrap_or(&Value::Null),
                "icon": m.get("logo").and_then(|l| l.get("thumbnailUrl")).and_then(|v| v.as_str()).unwrap_or(""),
                "url": m.get("links").and_then(|l| l.get("websiteUrl")).and_then(|v| v.as_str()).unwrap_or(""),
                "categories": m.get("categories").and_then(|c| c.as_array()).cloned().unwrap_or_default().into_iter().filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(Value::Array(out))
}

pub async fn curseforge_files(mod_id: &str, mc_version: &str) -> CmdResult<Value> {
    let params = [("gameVersion", mc_version)];
    let qs = serde_urlencoded::to_string(&params).unwrap_or_default();
    let resp = http()
        .get(format!("{CF_API}/mods/{mod_id}/files?{qs}"))
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(AppError::Msg(format!(
            "获取文件列表失败 (HTTP {})",
            resp.status()
        )));
    }
    let data: Value = resp.json().await.map_err(|e| AppError::Msg(e.to_string()))?;
    let arr = data.get("data").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut out: Vec<Value> = arr
        .into_iter()
        .map(|f| {
            json!({
                "id": f.get("id").unwrap_or(&Value::Null),
                "name": f.get("fileName").and_then(|v| v.as_str()).unwrap_or(""),
                "displayName": f.get("displayName").and_then(|v| v.as_str()).unwrap_or(""),
                "size": f.get("fileLength").unwrap_or(&Value::Null),
                "releaseType": f.get("releaseType").unwrap_or(&Value::Null),
                "gameVersions": f.get("gameVersions").cloned().unwrap_or(Value::Array(vec![])),
                "downloadUrl": f.get("downloadUrl").and_then(|v| v.as_str()).unwrap_or(""),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b.get("id")
            .and_then(|x| x.as_i64())
            .unwrap_or(0)
            .cmp(&a.get("id").and_then(|x| x.as_i64()).unwrap_or(0))
    });
    Ok(Value::Array(out))
}

pub async fn curseforge_download(file: &Value, game_dir: &str) -> CmdResult<String> {
    let name = file.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let url = file.get("downloadUrl").and_then(|v| v.as_str()).unwrap_or("");
    if url.is_empty() {
        return Err(AppError::Msg("该文件不提供直链下载（CurseForge 限制），请打开网页手动下载".into()));
    }
    let dest = Path::new(game_dir).join("mods").join(name);
    download_file(url, &dest).await.map_err(AppError::Msg)?;
    Ok(dest.to_string_lossy().to_string())
}

pub async fn curseforge_install_world(file: &Value, game_dir: &str) -> CmdResult<String> {
    let url = file.get("downloadUrl").and_then(|v| v.as_str()).unwrap_or("");
    if url.is_empty() {
        return Err(AppError::Msg("该文件不提供直链下载（CurseForge 限制）".into()));
    }
    let tmp_zip = std::env::temp_dir().join(format!("cm-world-{}.zip", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()));
    download_file(url, &tmp_zip).await.map_err(AppError::Msg)?;

    let tmp_dir = std::env::temp_dir().join(format!("cm-world-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()));
    fs::create_dir_all(&tmp_dir)?;
    extract_zip(&tmp_zip, &tmp_dir)?;

    let saves_dir = Path::new(game_dir).join("saves");
    fs::create_dir_all(&saves_dir)?;

    let world_src = find_world_dir(&tmp_dir).ok_or_else(|| AppError::Msg("压缩包内未找到世界文件（level.dat）".into()))?;
    let world_name = world_src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("world");
    let mut dest = saves_dir.join(world_name);
    let mut n = 1;
    while dest.exists() {
        dest = saves_dir.join(format!("{world_name}-{n}"));
        n += 1;
    }
    copy_dir_recursive(&world_src, &dest).map_err(AppError::Msg)?;

    let _ = fs::remove_file(&tmp_zip);
    let _ = fs::remove_dir_all(&tmp_dir);
    Ok(dest.to_string_lossy().to_string())
}

fn find_world_dir(dir: &Path) -> Option<PathBuf> {
    if dir.join("level.dat").exists() {
        return Some(dir.to_path_buf());
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        if entry.file_type().ok()?.is_dir() {
            if let Some(hit) = find_world_dir(&entry.path()) {
                return Some(hit);
            }
        }
    }
    None
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let s = entry.path();
        let d = dest.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else {
            fs::copy(&s, &d).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let out = dest.join(&name);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut f = fs::File::create(&out).map_err(|e| e.to_string())?;
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            f.write_all(&buf).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
