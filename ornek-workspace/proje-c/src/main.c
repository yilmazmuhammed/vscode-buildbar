#include <stdio.h>

#include "parser.h"

int main(void)
{
    static const char *lines[] = {
        "CONFIG_IPV6_MULTIPLE_TABLES=y",
        "CONFIG_LOG_LEVEL=3",
        "bozuk-satir"
    };

    char key[64];
    char value[64];

    for (size_t i = 0; i < sizeof(lines) / sizeof(lines[0]); i++) {
        if (parse_kv(lines[i], key, sizeof(key), value, sizeof(value))) {
            printf("%-32s -> %s\n", key, value);
        } else {
            printf("%-32s -> ayristirilamadi\n", lines[i]);
        }
    }
    return 0;
}
