#ifndef RING_H
#define RING_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define RING_CAPACITY 8u

/* Tek uretici / tek tuketici halka tampon.
   Paylasilan indeksler _Atomic; C'de volatile veri yarisini cozmez. */
struct ring {
    uint8_t buf[RING_CAPACITY];
    _Atomic size_t head;
    _Atomic size_t tail;
};

void ring_init(struct ring *r);
bool ring_push(struct ring *r, uint8_t value);
bool ring_pop(struct ring *r, uint8_t *out);

#endif /* RING_H */
