#include <stdio.h>

#include "ring.h"

int main(void)
{
    struct ring r;
    ring_init(&r);

    for (uint8_t i = 0; i < 5u; i++) {
        if (!ring_push(&r, (uint8_t)(i * 3u))) {
            puts("push basarisiz");
            return 1;
        }
    }

    uint8_t value;
    while (ring_pop(&r, &value)) {
        printf("pop: %u\n", value);
    }
    return 0;
}
