#include <sys/wait.h>
#include <unistd.h>
#include <iostream>

int main() {
  const pid_t child = fork();
  if (child == 0) {
    volatile unsigned long long value = 0;
    for (unsigned long long i = 0; i < 30000000ULL; ++i) value += i;
    _exit(value == 0 ? 1 : 0);
  }
  if (child < 0) return 2;
  int status = 0;
  if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 3;
  std::cout << "42\n";
}
