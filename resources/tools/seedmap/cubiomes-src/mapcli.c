/* mapcli.c — CM Launcher 种子地图引擎命令行接口
 *
 * 基于 cubiomes（Cubitect，AGPL-3.0-or-later）。对渲染层只暴露几条简单命令：
 *
 *   tile <ver> <dim> <seed> <scale> <x> <z> <w> <h>
 *        先输出一行 "OK"，随后输出 w*h 个 RGB 像素（每像素代表 scale 个方块）
 *
 *   structs <ver> <dim> <seed> <bx0> <bz0> <bx1> <bz1>
 *        逐行输出 "<类型> <方块x> <方块z>"，以 "END" 结束
 *
 *   stronghold <ver> <seed>
 *        逐行输出 "<方块x> <方块z>"，以 "END" 结束
 *
 *   spawn <ver> <seed>          输出 "<方块x> <方块z>"
 *   slime <seed> <cx0> <cz0> <cx1> <cz1>
 *        逐行输出 "<区块x> <区块z>"，以 "END" 结束
 *
 * 出错一律走 stderr + 非零退出，stdout 保持干净。
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <fcntl.h>
#include <io.h>

#include "finders.h"
#include "generator.h"
#include "util.h"

/* 让 stdout 保持二进制：避免 OK\n 被写成 OK\r\n，保证协议字节精确 */
static void setBinaryStdout(void)
{
    _setmode(_fileno(stdout), _O_BINARY);
}

/* 各维度要列出的点结构（密集的废弃矿井 / 埋藏宝藏 / 紫晶洞不列入，否则标记铺满地） */
static const int OW_STRUCTS[] = {
    Desert_Pyramid, Jungle_Temple, Swamp_Hut, Igloo, Village,
    Ocean_Ruin, Shipwreck, Monument, Mansion, Outpost,
    Ruined_Portal, Ancient_City, Trail_Ruins, Trial_Chambers,
};
static const int NETH_STRUCTS[] = { Fortress, Bastion, Ruined_Portal_N };
static const int END_STRUCTS[] = { End_City };

static uint64_t parseSeed(const char *s)
{
    /* TCC 的导入定义里没有 strtoll，msvcrt 导出的名字是 _strtoi64 */
    return (uint64_t) _strtoi64(s, NULL, 10);
}

static int failUsage(void)
{
    fprintf(stderr, "bad arguments\n");
    return 2;
}

/* 取 (bx,bz) 处地表生物群系（scale 4），失败返回 -1。
 * 主世界在 y=15（约方块 60+ 的地表）采样；y 传 63（方块 252）既没有地表意义，
 * 还会踩到深处的边界问题。下界 / 末地群系不随高度变化，保持 63。 */
static int surfaceBiome(const Generator *g, int dim, int bx, int bz)
{
    return getBiomeAt(g, 4, bx, dim == DIM_OVERWORLD ? 15 : 63, bz);
}

static int cmdTile(int argc, char **argv)
{
    if (argc != 10) return failUsage();

    int mc = str2mc(argv[2]);
    int dim = atoi(argv[3]);
    uint64_t seed = parseSeed(argv[4]);
    int scale = atoi(argv[5]);
    int x = atoi(argv[6]);
    int z = atoi(argv[7]);
    int w = atoi(argv[8]);
    int h = atoi(argv[9]);

    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) {
        fprintf(stderr, "bad tile size\n");
        return 2;
    }
    if (scale != 4 && scale != 16 && scale != 64 && scale != 256) {
        fprintf(stderr, "scale must be 4/16/64/256\n");
        return 2;
    }

    static unsigned char biomeColors[256][3];
    initBiomeColors(biomeColors);

    Generator g;
    setupGenerator(&g, mc, 0);
    applySeed(&g, dim, seed);

    unsigned char *pixels = (unsigned char *) malloc((size_t) w * h * 3);
    if (!pixels) { fprintf(stderr, "oom\n"); return 3; }

    /* 所有缩放级别都走批量 genBiomes：内部一次噪声采样摊给整片输出，
       比逐点 surfaceBiome 快两个数量级（983×541 从 ~9s 降到几百 ms）。
       输出第 (i,j) 个像素对应方块 (x+i*scale, z+j*scale)。 */
    Range r;
    r.scale = scale;
    r.sx = w;
    r.sy = 1;
    r.sz = h;
    r.x = x;
    r.y = (dim == DIM_OVERWORLD) ? 15 : 63;
    r.z = z;

    int *cache = (int *) malloc((size_t) getMinCacheSize(&g, r.scale, r.sx, r.sy, r.sz) * sizeof(int));
    if (!cache) { fprintf(stderr, "oom\n"); return 3; }

    if (genBiomes(&g, cache, r) != 0) {
        fprintf(stderr, "genBiomes failed\n");
        return 3;
    }

    for (int j = 0; j < h; j++) {
        for (int i = 0; i < w; i++) {
            int id = cache[(size_t) j * w + i];
            unsigned char *px = pixels + ((size_t) j * w + i) * 3;
            if (id < 0 || id > 255) { px[0] = px[1] = px[2] = 0; }
            else { px[0] = biomeColors[id][0]; px[1] = biomeColors[id][1]; px[2] = biomeColors[id][2]; }
        }
    }
    free(cache);

    printf("OK\n");
    fflush(stdout);
    size_t n = fwrite(pixels, 3, (size_t) w * h, stdout);
    if (n != (size_t) w * h) { fprintf(stderr, "short write\n"); return 3; }
    free(pixels);
    return 0;
}

static int cmdStructs(int argc, char **argv)
{
    if (argc != 9) return failUsage();

    int mc = str2mc(argv[2]);
    int dim = atoi(argv[3]);
    uint64_t seed = parseSeed(argv[4]);
    int bx0 = atoi(argv[5]), bz0 = atoi(argv[6]);
    int bx1 = atoi(argv[7]), bz1 = atoi(argv[8]);

    const int *types;
    int ntypes;
    if (dim == DIM_OVERWORLD) { types = OW_STRUCTS; ntypes = (int)(sizeof(OW_STRUCTS)/sizeof(int)); }
    else if (dim == DIM_NETHER) { types = NETH_STRUCTS; ntypes = (int)(sizeof(NETH_STRUCTS)/sizeof(int)); }
    else if (dim == DIM_END) { types = END_STRUCTS; ntypes = (int)(sizeof(END_STRUCTS)/sizeof(int)); }
    else return failUsage();

    Generator g;
    setupGenerator(&g, mc, 0);
    applySeed(&g, dim, seed);

    for (int t = 0; t < ntypes; t++) {
        int type = types[t];
        StructureConfig sc;
        if (!getStructureConfig(type, mc, &sc)) continue;

        int reg = sc.regionSize * 16;
        int rx0 = bx0 / reg - 1, rx1 = bx1 / reg + 1;
        int rz0 = bz0 / reg - 1, rz1 = bz1 / reg + 1;

        for (int rz = rz0; rz <= rz1; rz++) {
            for (int rx = rx0; rx <= rx1; rx++) {
                Pos pos;
                if (!getStructurePos(type, mc, seed, rx, rz, &pos)) continue;
                if (pos.x < bx0 || pos.x > bx1 || pos.z < bz0 || pos.z > bz1) continue;
                /* 生物群系条件：只有真的会生成的才标记 */
                if (!isViableStructurePos(type, &g, pos.x, pos.z, 0)) continue;
                printf("%d %d %d\n", type, pos.x, pos.z);
            }
        }
    }
    printf("END\n");
    return 0;
}

static int cmdStronghold(int argc, char **argv)
{
    if (argc != 4) return failUsage();

    int mc = str2mc(argv[2]);
    uint64_t seed = parseSeed(argv[3]);

    Generator g;
    setupGenerator(&g, mc, 0);
    applySeed(&g, DIM_OVERWORLD, seed);

    StrongholdIter sh;
    initFirstStronghold(&sh, mc, seed);

    int guard = 0;
    /* initFirstStronghold 只做初始化：它显式把 sh.pos 置 {0,0}，第一个要塞的
       近似位置放在 sh.nextapprox。必须先 nextStronghold 把 nextapprox 转成
       sh.pos 再打印 —— 以前 do-while 先打印，导致每行结果前面恒有一个假的 "0 0"。 */
    while (nextStronghold(&sh, NULL) > 0) {
        printf("%d %d\n", sh.pos.x, sh.pos.z);
        if (++guard > 256) break;
        /* NULL：使用几何近似位置（与 Chunkbase 一致）。传 &g 会逐个群系精修，
           129 个要塞要多花约 7 秒，而误差不超过 112 格，地图标注无需精修。 */
    }

    printf("END\n");
    return 0;
}

static int cmdSpawn(int argc, char **argv)
{
    if (argc != 4) return failUsage();

    int mc = str2mc(argv[2]);
    uint64_t seed = parseSeed(argv[3]);

    Generator g;
    setupGenerator(&g, mc, 0);
    applySeed(&g, DIM_OVERWORLD, seed);

    Pos p = estimateSpawn(&g, NULL);
    printf("%d %d\n", p.x, p.z);
    return 0;
}

static int cmdSlime(int argc, char **argv)
{
    if (argc != 7) return failUsage();

    uint64_t seed = parseSeed(argv[2]);
    int cx0 = atoi(argv[3]), cz0 = atoi(argv[4]);
    int cx1 = atoi(argv[5]), cz1 = atoi(argv[6]);

    /* 区块数做个上限，防止界面传错范围跑太久 */
    if (cx1 - cx0 > 2048 || cz1 - cz0 > 2048) {
        fprintf(stderr, "slime range too large\n");
        return 2;
    }

    for (int cz = cz0; cz <= cz1; cz++) {
        for (int cx = cx0; cx <= cx1; cx++) {
            if (isSlimeChunk(seed, cx, cz)) printf("%d %d\n", cx, cz);
        }
    }
    printf("END\n");
    return 0;
}

static int cmdBiome(int argc, char **argv)
{
    if (argc != 7) return failUsage();

    int mc = str2mc(argv[2]);
    int dim = atoi(argv[3]);
    uint64_t seed = parseSeed(argv[4]);
    int x = atoi(argv[5]), z = atoi(argv[6]);

    Generator g;
    setupGenerator(&g, mc, 0);
    applySeed(&g, dim, seed);

    printf("%d\n", surfaceBiome(&g, dim, x, z));
    return 0;
}

int main(int argc, char **argv)
{
    setBinaryStdout();
    if (argc < 2) return failUsage();

    if (!strcmp(argv[1], "tile")) return cmdTile(argc, argv);
    if (!strcmp(argv[1], "structs")) return cmdStructs(argc, argv);
    if (!strcmp(argv[1], "stronghold")) return cmdStronghold(argc, argv);
    if (!strcmp(argv[1], "spawn")) return cmdSpawn(argc, argv);
    if (!strcmp(argv[1], "slime")) return cmdSlime(argc, argv);
    if (!strcmp(argv[1], "biome")) return cmdBiome(argc, argv);

    return failUsage();
}
