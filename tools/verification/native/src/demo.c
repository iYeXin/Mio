/*
 * Mio native demo library.
 *
 * Exports a handful of scalar functions plus the optional `mio_start` entry.
 * Builds on Windows (cl /LD) and Android (NDK clang).
 */
#include <stdint.h>

typedef void (*mio_sink_fn)(int32_t event, int64_t a, int64_t b, double c);

#ifdef _WIN32
#include <windows.h>
#define EXPORT __declspec(dllexport)
static void sleep_ms(int ms) { Sleep((DWORD)ms); }
#else
#include <pthread.h>
#include <unistd.h>
#define EXPORT __attribute__((visibility("default")))
static void sleep_ms(int ms) { usleep((useconds_t)ms * 1000); }
#endif

static mio_sink_fn g_sink = 0;

EXPORT int32_t mio_add(int32_t a, int32_t b) { return a + b; }

EXPORT double mio_scale(double a, double b) { return a * b; }

EXPORT int64_t mio_tick(int64_t value) { return value + 1000; }

EXPORT int32_t mio_mix(int32_t a, double b) { return a + (int32_t)b; }

EXPORT int32_t mio_length(const char *text) {
  int32_t length = 0;
  if (text == 0) return -1;
  while (text[length] != 0) length++;
  return length;
}

EXPORT void mio_noop(void) {}

/* Blocks the calling thread; used to prove calls run off the UI isolate. */
EXPORT int32_t mio_sleep(int32_t ms) {
  if (ms > 0) sleep_ms(ms);
  return ms;
}

static void emit_sequence(void) {
  for (int i = 1; i <= 5; i++) {
    if (g_sink == 0) return;
    g_sink(100, i, i * 10, i * 0.5);
    sleep_ms(80);
  }
  if (g_sink != 0) g_sink(999, 0, 0, 0.0);
}

#ifdef _WIN32
static DWORD WINAPI worker(LPVOID argument) {
  (void)argument;
  emit_sequence();
  return 0;
}
#else
static void *worker(void *argument) {
  (void)argument;
  emit_sequence();
  return 0;
}
#endif

EXPORT int32_t mio_start(mio_sink_fn sink, const char *config) {
  g_sink = sink;
  int32_t config_length = 0;
  if (config != 0) {
    while (config[config_length] != 0) config_length++;
  }
  if (g_sink != 0) g_sink(1, config_length, 0, 0.0);
#ifdef _WIN32
  CreateThread(0, 0, worker, 0, 0, 0);
#else
  pthread_t thread;
  pthread_create(&thread, 0, worker, 0);
#endif
  return 7;
}

/* Counter-direction: the page pushes an event in, the library echoes it back. */
EXPORT void mio_event(int32_t event, int64_t a, int64_t b, double c) {
  if (event == 42 && g_sink != 0) {
    g_sink(43, a, b, c);
  }
}

/* Optional shutdown hook: report that we stopped, then stop accepting events. */
EXPORT void mio_stop(void) {
  if (g_sink != 0) {
    g_sink(77, 0, 0, 0.0);
  }
  g_sink = 0;
}
