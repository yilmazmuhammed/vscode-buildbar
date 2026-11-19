#include "ring.h"

#include <stdatomic.h>

void ring_init(struct ring *r)
{
    atomic_store_explicit(&r->head, 0u, memory_order_relaxed);
    atomic_store_explicit(&r->tail, 0u, memory_order_relaxed);
}

bool ring_push(struct ring *r, uint8_t value)
{
    size_t head = atomic_load_explicit(&r->head, memory_order_relaxed);
    size_t tail = atomic_load_explicit(&r->tail, memory_order_acquire);
    size_t next = (head + 1u) % RING_CAPACITY;

    if (next == tail) {
        return false; /* dolu */
    }

    r->buf[head] = value;
    atomic_store_explicit(&r->head, next, memory_order_release);
    return true;
}

bool ring_pop(struct ring *r, uint8_t *out)
{
    size_t tail = atomic_load_explicit(&r->tail, memory_order_relaxed);
    size_t head = atomic_load_explicit(&r->head, memory_order_acquire);

    if (tail == head) {
        return false; /* bos */
    }

    *out = r->buf[tail];
    atomic_store_explicit(&r->tail, (tail + 1u) % RING_CAPACITY, memory_order_release);
    return true;
}
