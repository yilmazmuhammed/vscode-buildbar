#include "parser.h"

#include <stddef.h>
#include <string.h>

bool parse_kv(const char *line, char *key, size_t key_len,
              char *value, size_t value_len)
{
    const char *eq = strchr(line, '=');
    if (eq == NULL || eq == line) {
        return false;
    }

    size_t klen = (size_t)(eq - line);
    size_t vlen = strlen(eq + 1);

    if (klen + 1u > key_len || vlen + 1u > value_len) {
        return false;
    }

    memcpy(key, line, klen);
    key[klen] = '\0';
    memcpy(value, eq + 1, vlen + 1u);
    return true;
}
