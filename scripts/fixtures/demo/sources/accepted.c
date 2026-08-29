#include <stdio.h>

int main(void) {
  long long value;
  if (scanf("%lld", &value) != 1) return 1;
  printf("%lld\n", value * 2);
  return 0;
}
