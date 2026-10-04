//! 存档（世界）编辑：读写 level.dat（gzip + NBT）。
//! 对齐 Electron 版 minecraft/world.js。

use fastnbt::Value;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Map as JsonMap, Number as JsonNumber, Value as JsonValue};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

const GAMEMODES: &[(&str, &str)] = &[
    ("0", "生存"),
    ("1", "创造"),
    ("2", "冒险"),
    ("3", "旁观"),
];

const DIFFICULTIES: &[(&str, &str)] = &[
    ("0", "和平"),
    ("1", "简单"),
    ("2", "普通"),
    ("3", "困难"),
];

const GAMERULES: &[(&str, &str, &str)] = &[
    ("keepInventory", "死亡不掉落", "bool"),
    ("doDaylightCycle", "昼夜循环", "bool"),
    ("doWeatherCycle", "天气变化", "bool"),
    ("doMobSpawning", "生物自然生成", "bool"),
    ("doMobLoot", "生物掉落物", "bool"),
    ("doTileDrops", "方块掉落", "bool"),
    ("mobGriefing", "生物破坏方块", "bool"),
    ("doFireTick", "火焰蔓延", "bool"),
    ("naturalRegeneration", "自然回血", "bool"),
    ("fallDamage", "摔落伤害", "bool"),
    ("fireDamage", "火焰伤害", "bool"),
    ("drowningDamage", "溺水伤害", "bool"),
    ("freezeDamage", "冰冻伤害", "bool"),
    ("doImmediateRespawn", "立即重生", "bool"),
    ("showDeathMessages", "显示死亡消息", "bool"),
    ("sendCommandFeedback", "命令反馈", "bool"),
    ("commandBlockOutput", "命令方块输出", "bool"),
    ("announceAdvancements", "播报进度", "bool"),
    ("logAdminCommands", "记录管理员命令", "bool"),
    ("reducedDebugInfo", "简化调试信息", "bool"),
    ("doInsomnia", "幻翼生成", "bool"),
    ("doPatrolSpawning", "灾厄巡逻队", "bool"),
    ("doTraderSpawning", "流浪商人", "bool"),
    ("doWardenSpawning", "监守者生成", "bool"),
    ("spectatorsGenerateChunks", "旁观者加载区块", "bool"),
    ("disableElytraMovementCheck", "关闭鞘翅移动检测", "bool"),
    ("doLimitedCrafting", "限制合成配方", "bool"),
    ("universalAnger", "通用愤怒", "bool"),
    ("forgiveDeadPlayers", "原谅死亡玩家", "bool"),
    ("globalSoundEvents", "全局音效事件", "bool"),
    ("spawnRadius", "出生点半径", "int"),
    ("randomTickSpeed", "随机刻速度", "int"),
    ("maxEntityCramming", "实体挤压上限", "int"),
    ("maxCommandChainLength", "命令链最大长度", "int"),
    ("playersSleepingPercentage", "睡觉跳过夜晚百分比", "int"),
];

pub fn schema() -> JsonValue {
    json!({
        "gamemodes": GAMEMODES.iter().map(|(id,name)| json!({"id":id.parse::<i64>().unwrap_or(0),"name":name})).collect::<Vec<_>>(),
        "difficulties": DIFFICULTIES.iter().map(|(id,name)| json!({"id":id.parse::<i64>().unwrap_or(0),"name":name})).collect::<Vec<_>>(),
        "gamerules": GAMERULES.iter().map(|(k,label,ty)| json!({"key":k,"label":label,"type":ty})).collect::<Vec<_>>(),
    })
}

fn read_level(save_dir: &str) -> Result<(Value, Value), String> {
    let file = Path::new(save_dir).join("level.dat");
    if !file.exists() {
        return Err("该存档缺少 level.dat".into());
    }
    let raw = fs::read(&file).map_err(|e| e.to_string())?;
    let mut decoder = GzDecoder::new(&raw[..]);
    let mut decompressed = Vec::new();
    decoder.read_to_end(&mut decompressed).map_err(|_| "level.dat 解压失败，可能已损坏".to_string())?;
    let root: Value = fastnbt::from_bytes(&decompressed).map_err(|e| format!("NBT 解析失败：{e}"))?;
    let data = match &root {
        Value::Compound(map) => map
            .get("Data")
            .ok_or("level.dat 结构异常：缺少 Data".to_string())?
            .clone(),
        _ => return Err("level.dat 结构异常".into()),
    };
    Ok((root, data))
}

fn num_val(v: &Value, def: i64) -> i64 {
    match v {
        Value::Byte(b) => *b as i64,
        Value::Short(s) => *s as i64,
        Value::Int(i) => *i as i64,
        Value::Long(l) => *l as i64,
        _ => def,
    }
}

fn build_info(save_dir: &str, data: &Value, with_rules: bool) -> JsonValue {
    let dir_name = Path::new(save_dir).file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let get = |k: &str| -> Option<&Value> {
        if let Value::Compound(m) = data {
            m.get(k)
        } else {
            None
        }
    };
    let name = get("LevelName")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| dir_name.clone());
    let version = if let Some(Value::Compound(vmap)) = get("Version") {
        let vname = vmap.get("Name").and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default();
        let vid = vmap.get("Id").map(|v| num_val(v, 0)).unwrap_or(0);
        json!({ "name": vname, "id": vid })
    } else {
        JsonValue::Null
    };
    let mut info = json!({
        "dirName": dir_name,
        "name": name,
        "gameType": get("GameType").map(|v| num_val(v, 0)).unwrap_or(0),
        "difficulty": get("Difficulty").map(|v| num_val(v, 2)).unwrap_or(2),
        "hardcore": get("hardcore").map(|v| num_val(v, 0) != 0).unwrap_or(false),
        "allowCommands": get("allowCommands").map(|v| num_val(v, 0) != 0).unwrap_or(false),
        "difficultyLocked": get("DifficultyLocked").map(|v| num_val(v, 0) != 0).unwrap_or(false),
        "seed": get("RandomSeed").map(|v| num_val(v, 0).to_string()).unwrap_or_else(|| "0".to_string()),
        "dataVersion": get("DataVersion").map(|v| num_val(v, 0)).unwrap_or(0),
        "version": version,
    });
    if with_rules {
        let mut rules = JsonMap::new();
        if let Some(Value::Compound(gr)) = get("GameRules") {
            for (k, v) in gr {
                let s = match v {
                    Value::String(s) => s.clone(),
                    Value::Byte(b) => b.to_string(),
                    Value::Int(i) => i.to_string(),
                    Value::Long(l) => l.to_string(),
                    _ => String::new(),
                };
                rules.insert(k.clone(), JsonValue::String(s));
            }
        }
        if let JsonValue::Object(m) = &mut info {
            m.insert("gamerules".into(), JsonValue::Object(rules));
        }
    }
    info
}

pub fn list_worlds(game_dir: &str) -> JsonValue {
    let saves = crate::mc::content::list_saves(game_dir);
    let arr = saves.as_array().cloned().unwrap_or_default();
    let mut out: Vec<JsonValue> = Vec::new();
    for s in arr {
        let path = s["path"].as_str().unwrap_or("");
        let has_level = s["hasLevel"].as_bool().unwrap_or(false);
        let meta = if has_level {
            read_level(path).ok().map(|(_, data)| build_info(path, &data, false))
        } else {
            None
        };
        let mut obj = s.as_object().cloned().unwrap_or_default();
        obj.insert("meta".into(), meta.unwrap_or(JsonValue::Null));
        out.push(JsonValue::Object(obj));
    }
    JsonValue::Array(out)
}

pub fn world_info(save_dir: &str) -> Result<JsonValue, String> {
    let (_, data) = read_level(save_dir)?;
    Ok(build_info(save_dir, &data, true))
}

/// 把值写入 NBT compound
fn set_val(compound: &mut Value, name: &str, value: Value) {
    if let Value::Compound(m) = compound {
        m.insert(name.to_string(), value);
    }
}

pub fn update_world(save_dir: &str, patch: &JsonValue) -> Result<JsonValue, String> {
    let (mut root, mut data) = read_level(save_dir)?;

    if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            set_val(&mut data, "LevelName", Value::String(trimmed.to_string()));
        }
    }
    if let Some(gt) = patch.get("gameType").and_then(|v| v.as_i64()) {
        set_val(&mut data, "GameType", Value::Int(gt as i32));
        // 单人存档中玩家自身模式会覆盖世界默认值，一并修改
        if let Value::Compound(dm) = &mut data {
            if let Some(Value::Compound(p)) = dm.get_mut("Player") {
                if let Some(pgt) = p.get_mut("playerGameType") {
                    *pgt = Value::Int(gt as i32);
                }
            }
        }
    }
    if let Some(diff) = patch.get("difficulty").and_then(|v| v.as_i64()) {
        set_val(&mut data, "Difficulty", Value::Byte(diff as i8));
    }
    if let Some(hc) = patch.get("hardcore").and_then(|v| v.as_bool()) {
        set_val(&mut data, "hardcore", Value::Byte(if hc { 1 } else { 0 }));
    }
    if let Some(ac) = patch.get("allowCommands").and_then(|v| v.as_bool()) {
        set_val(&mut data, "allowCommands", Value::Byte(if ac { 1 } else { 0 }));
    }
    if let Some(seed_str) = patch.get("seed").and_then(|v| v.as_str()) {
        if let Ok(seed) = seed_str.trim().parse::<i64>() {
            set_val(&mut data, "RandomSeed", Value::Long(seed));
        }
    }
    if let Some(rules) = patch.get("gamerules").and_then(|v| v.as_object()) {
        // 确保 Data 下有 GameRules compound
        if let Value::Compound(dm) = &mut data {
            let gr = dm.entry("GameRules".to_string()).or_insert(Value::Compound(Default::default()));
            if let Value::Compound(gm) = gr {
                for (k, val) in rules {
                    gm.insert(k.clone(), Value::String(val.to_string()));
                }
            }
        }
    }

    // 写回 root
    if let Value::Compound(rm) = &mut root {
        rm.insert("Data".to_string(), data.clone());
    }

    let file = Path::new(save_dir).join("level.dat");
    // 备份
    let _ = fs::copy(&file, format!("{}_old", file.display()));
    let bytes = fastnbt::to_bytes(&root).map_err(|e| format!("NBT 序列化失败：{e}"))?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&bytes).map_err(|e| e.to_string())?;
    let compressed = encoder.finish().map_err(|e| e.to_string())?;
    fs::write(&file, compressed).map_err(|e| e.to_string())?;

    Ok(build_info(save_dir, &data, true))
}
