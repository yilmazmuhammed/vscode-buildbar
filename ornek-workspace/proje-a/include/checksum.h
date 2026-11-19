#ifndef CHECKSUM_H
#define CHECKSUM_H

#include <stddef.h>
#include <stdint.h>

uint32_t crc32_bytes(const void *data, size_t len);

#endif /* CHECKSUM_H */
