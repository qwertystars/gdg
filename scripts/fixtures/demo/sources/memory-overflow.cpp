// Memory overflow demo. Allocates far past the 256 MiB problem limit.
//
// Under delegated cgroup v2, memory.max produces an authoritative OOM event.
// The local RLIMIT_AS fallback observes peak virtual size near the hard limit
// so a failed allocation is classified as MEMORY_LIMIT_EXCEEDED rather than
// an ambiguous non-zero runtime exit.
#include <vector>

int main() {
    std::vector<std::vector<char>> blocks;
    while (true) {
        blocks.emplace_back(1024 * 1024, 'x');  // 1 MiB per block
    }
    return 0;
}
