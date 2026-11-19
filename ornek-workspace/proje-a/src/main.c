#include <stdio.h>
#include <string.h>
#include "checksum.h"

int main(void)
{
    const char *msg = "proje-a";
    printf("demo: %s\n", msg);
    printf("crc32: 0x%08x\n", crc32_bytes(msg, strlen(msg)));
    return 0;
}
