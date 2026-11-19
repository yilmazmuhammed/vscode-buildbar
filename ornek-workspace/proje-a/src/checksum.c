#include "checksum.h"

/* Bit bit CRC-32 (IEEE 802.3), tablo kullanmadan. */
uint32_t crc32_bytes(const void *data, size_t len)
{
    const uint8_t *p = (const uint8_t *)data;
    uint32_t crc = 0xffffffffu;

    for (size_t i = 0; i < len; i++) {
        crc ^= p[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc >> 1) ^ (0xedb88320u & (uint32_t)(-(int32_t)(crc & 1u)));
        }
    }
    return ~crc;
}
