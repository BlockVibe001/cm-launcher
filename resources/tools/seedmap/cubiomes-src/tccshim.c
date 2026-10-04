/* tccshim.c — TCC 0.9.27 / 系统 msvcrt.dll 缺少的几个 C99 数学函数
 * 仅编译进种子地图引擎，不影响其他任何部分。
 */
#include <math.h>
#include <stdint.h>
#include <string.h>

/* msvcrt 导出的是双精度 sqrt；sqrtf 别名在 TCC 的导入定义里缺失 */
float sqrtf(float x)
{
    return (float) sqrt((double) x);
}

/* 静默 NaN */
double nan(const char *tagp)
{
    (void) tagp;
    double qn;
    uint64_t bits = UINT64_C(0x7ff8000000000000);
    memcpy(&qn, &bits, sizeof(qn));
    return qn;
}

/* Abramowitz & Stegun 7.1.26：|误差| < 1.5e-7，足够世界生成噪声使用 */
double erf(double x)
{
    double sign = x < 0 ? -1.0 : 1.0;
    double ax = x < 0 ? -x : x;

    double t = 1.0 / (1.0 + 0.3275911 * ax);
    double y = 1.0 - (((((
        1.061405429 * t - 1.453152027) * t)
        + 1.421413741) * t - 0.284496736) * t
        + 0.254829592) * t * exp(-ax * ax);

    return sign * y;
}

double erfc(double x)
{
    return 1.0 - erf(x);
}
