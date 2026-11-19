#ifndef PARSER_H
#define PARSER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Basit "KEY=VALUE" ayristirici. */
bool parse_kv(const char *line, char *key, size_t key_len,
              char *value, size_t value_len);

#endif /* PARSER_H */
