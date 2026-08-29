// Memory overflow demo. Allocates far past the 256 MiB problem limit.
//
// Outcome note: with the current local judge-runner, this is classified as
// RUNTIME_ERROR. The runner sets RLIMIT_AS to the memory limit, so the
// process runs out of address space, the allocation throws std::bad_alloc,
// and the abort is reported as a runtime error. The runner's aggregate
// process-group sampler (which produces MEMORY_LIMIT_EXCEEDED) only fires
// when the group RSS crosses the limit, and a single process can never get
// there because RLIMIT_AS caps it first.
//
// A true MEMORY_LIMIT_EXCEEDED demo needs multiple processes whose
// combined RSS crosses the limit. The judge lane owns the runner and its
// classifications; when it adds such a fixture, mirror it here.
#include <vector>

int main() {
    std::vector<std::vector<char>> blocks;
    while (true) {
        blocks.emplace_back(1024 * 1024, 'x');  // 1 MiB per block
    }
    return 0;
}
