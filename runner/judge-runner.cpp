#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cerrno>
#include <filesystem>
#include <fcntl.h>
#include <fstream>
#include <grp.h>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <vector>
#include <optional>

namespace {
struct Options {
  std::string binary, input, output, error, metrics;
  std::vector<std::string> args;
  bool address_space_limit = true;
  long long wall_ms = 2000, cpu_ms = 1500, memory_kb = 262144, output_bytes = 1048576, max_processes = 16;
};

bool value(const std::string& name, int& i, int argc, char** argv, std::string& out) {
  if (name != argv[i] || i + 1 >= argc) return false;
  out = argv[++i];
  return true;
}

bool parse(int argc, char** argv, Options& o) {
  for (int i = 1; i < argc; ++i) {
    std::string v;
    if (value("--binary", i, argc, argv, v)) o.binary = v;
    else if (value("--input", i, argc, argv, v)) o.input = v;
    else if (value("--stdout", i, argc, argv, v)) o.output = v;
    else if (value("--stderr", i, argc, argv, v)) o.error = v;
    else if (value("--metrics", i, argc, argv, v)) o.metrics = v;
    else if (value("--arg", i, argc, argv, v)) o.args.push_back(v);
    else if (value("--memory-accounting", i, argc, argv, v)) {
      if (v == "address-space") o.address_space_limit = true;
      else if (v == "rss") o.address_space_limit = false;
      else return false;
    }
    else if (value("--wall-ms", i, argc, argv, v)) o.wall_ms = std::stoll(v);
    else if (value("--cpu-ms", i, argc, argv, v)) o.cpu_ms = std::stoll(v);
    else if (value("--memory-kb", i, argc, argv, v)) o.memory_kb = std::stoll(v);
    else if (value("--output-bytes", i, argc, argv, v)) o.output_bytes = std::stoll(v);
    else if (value("--max-processes", i, argc, argv, v)) o.max_processes = std::stoll(v);
    else return false;
  }
  return !o.binary.empty() && !o.input.empty() && !o.output.empty() && !o.error.empty() && !o.metrics.empty();
}

long long file_size(const std::string& path) {
  struct stat st{};
  return stat(path.c_str(), &st) == 0 ? static_cast<long long>(st.st_size) : 0;
}

bool write_text(const std::string& path, const std::string& value) {
  std::ofstream stream(path);
  if (!stream) return false;
  stream << value;
  return stream.good();
}

std::optional<long long> read_number(const std::string& path) {
  std::ifstream stream(path);
  long long value = 0;
  if (!(stream >> value)) return std::nullopt;
  return value;
}

class ExecutionCgroup {
 public:
  explicit ExecutionCgroup(const Options& options) {
    const std::string root = "/sys/fs/cgroup";
    path_ = root + "/gdg-judge-" + std::to_string(getpid());
    std::error_code ec;
    if (!std::filesystem::create_directory(path_, ec) || ec) return;
    const bool configured =
        write_text(path_ + "/memory.max", std::to_string(options.memory_kb * 1024)) &&
        write_text(path_ + "/pids.max", std::to_string(options.max_processes));
    // Swap must not let a submission exceed its contest memory allocation.
    write_text(path_ + "/memory.swap.max", "0");
    active_ = configured;
    if (!active_) cleanup();
  }

  ~ExecutionCgroup() { cleanup(); }
  bool active() const { return active_; }
  bool attach_self() const { return active_ && write_text(path_ + "/cgroup.procs", std::to_string(getpid())); }
  void kill_all() const { if (active_) write_text(path_ + "/cgroup.kill", "1"); }
  long long peak_memory_kb() const {
    const auto bytes = active_ ? read_number(path_ + "/memory.peak") : std::nullopt;
    return bytes ? *bytes / 1024 : 0;
  }
  long long cpu_time_ns() const {
    if (!active_) return 0;
    std::ifstream stream(path_ + "/cpu.stat");
    std::string key;
    long long value = 0;
    while (stream >> key >> value) if (key == "usage_usec") return value * 1000;
    return 0;
  }
  bool memory_event(const std::string& wanted) const {
    if (!active_) return false;
    std::ifstream stream(path_ + "/memory.events");
    std::string key;
    long long value = 0;
    while (stream >> key >> value) if (key == wanted && value > 0) return true;
    return false;
  }

 private:
  std::string path_;
  bool active_ = false;
  void cleanup() {
    if (path_.empty()) return;
    std::error_code ec;
    std::filesystem::remove(path_, ec);
  }
};

std::map<pid_t, pid_t> processes() {
  std::map<pid_t, pid_t> result;
  for (const auto& entry : std::filesystem::directory_iterator("/proc")) {
    const std::string name = entry.path().filename().string();
    if (name.empty() || name.find_first_not_of("0123456789") != std::string::npos) continue;
    std::ifstream status(entry.path() / "status");
    std::string key;
    pid_t pid = static_cast<pid_t>(std::stol(name));
    pid_t parent = -1;
    while (std::getline(status, key)) {
      if (key.rfind("PPid:", 0) == 0) parent = static_cast<pid_t>(std::stol(key.substr(5)));
    }
    if (parent >= 0) result[pid] = parent;
  }
  return result;
}

std::vector<pid_t> process_tree(pid_t root) {
  const auto all = processes();
  std::vector<pid_t> tree{root};
  for (size_t i = 0; i < tree.size(); ++i) {
    for (const auto& [pid, parent] : all) if (parent == tree[i]) tree.push_back(pid);
  }
  return tree;
}

long long tree_rss_kb(pid_t root) {
  long long total = 0;
  for (pid_t pid : process_tree(root)) {
    std::ifstream status("/proc/" + std::to_string(pid) + "/status");
    std::string line;
    while (std::getline(status, line)) {
      if (line.rfind("VmRSS:", 0) == 0) { total += std::stoll(line.substr(6)); break; }
    }
  }
  return total;
}

long long tree_virtual_kb(pid_t root) {
  long long total = 0;
  for (pid_t pid : process_tree(root)) {
    std::ifstream status("/proc/" + std::to_string(pid) + "/status");
    std::string line;
    while (std::getline(status, line)) {
      if (line.rfind("VmSize:", 0) == 0) { total += std::stoll(line.substr(7)); break; }
    }
  }
  return total;
}

void kill_tree(pid_t root) {
  const auto tree = process_tree(root);
  for (auto it = tree.rbegin(); it != tree.rend(); ++it) if (*it != root) kill(*it, SIGKILL);
}

void kill_group(pid_t pid, const ExecutionCgroup* cgroup = nullptr) {
  if (cgroup) cgroup->kill_all();
  if (pid > 0) kill(-pid, SIGKILL);
  kill_tree(getpid());
  kill(pid, SIGKILL);
}

long long ns(const struct timeval& t) {
  return static_cast<long long>(t.tv_sec) * 1000000000LL + static_cast<long long>(t.tv_usec) * 1000LL;
}
}

int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "--help") {
    std::cout << "judge-runner --binary PATH [--arg VALUE ...] --memory-accounting address-space|rss"
                 " --input PATH --stdout PATH --stderr PATH --metrics PATH"
                 " --wall-ms N --cpu-ms N --memory-kb N --output-bytes N --max-processes N\n";
    return 0;
  }
  Options o;
  if (!parse(argc, argv, o)) return 2;
  const auto started = std::chrono::steady_clock::now();
  prctl(PR_SET_CHILD_SUBREAPER, 1);
  ExecutionCgroup cgroup(o);
  pid_t child = fork();
  if (child < 0) return 3;
  if (child == 0) {
    setpgid(0, 0);
    // If the trusted supervisor is killed or preempted, the participant must
    // not continue running until the outer sandbox lifecycle catches up.
    prctl(PR_SET_PDEATHSIG, SIGKILL);
    if (getppid() == 1) _exit(125);
    if (cgroup.active() && !cgroup.attach_self()) _exit(125);
    int in = open(o.input.c_str(), O_RDONLY);
    int out = open(o.output.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    int err = open(o.error.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (in < 0 || out < 0 || err < 0) _exit(125);
    dup2(in, STDIN_FILENO); dup2(out, STDOUT_FILENO); dup2(err, STDERR_FILENO);
    close(in); close(out); close(err);
    struct rlimit cpu{static_cast<rlim_t>(std::max(1LL, (o.cpu_ms + 999) / 1000)), static_cast<rlim_t>(std::max(2LL, (o.cpu_ms + 1999) / 1000))};
    struct rlimit address{static_cast<rlim_t>(o.memory_kb * 1024), static_cast<rlim_t>(o.memory_kb * 1024)};
    struct rlimit nproc{static_cast<rlim_t>(o.max_processes), static_cast<rlim_t>(o.max_processes)};
    struct rlimit output{static_cast<rlim_t>(o.output_bytes), static_cast<rlim_t>(o.output_bytes)};
    struct rlimit core{0, 0};
    // Backend A:22: bound open file descriptors so a participant cannot
    // exhaust the container's fd table.
    struct rlimit nofile{64, 64};
    setrlimit(RLIMIT_CPU, &cpu);
    // A delegated cgroup gives authoritative resident-memory enforcement and
    // an OOM event. RLIMIT_AS is only the fallback: combining both can make
    // malloc fail before memory.max is reached, hiding an MLE as exit code 1.
    if (o.address_space_limit && !cgroup.active()) setrlimit(RLIMIT_AS, &address);
    // RLIMIT_NPROC is per real user, not per process tree. In production the
    // root supervisor drops every submission into the dedicated nobody UID,
    // so the limit is isolated. In local non-root development, applying it
    // would count unrelated developer processes and cause false failures.
    if (geteuid() == 0) setrlimit(RLIMIT_NPROC, &nproc);
    setrlimit(RLIMIT_FSIZE, &output);
    setrlimit(RLIMIT_CORE, &core);
    setrlimit(RLIMIT_NOFILE, &nofile);
    // Backend A:23: drop privileges before executing untrusted participant
    // code. The sandbox container runs as root, so switch the child to the
    // unprivileged 'nobody' account - otherwise the participant could modify
    // judge-owned files (stdout/stderr/metrics, the runner binary) and fake
    // its own metrics. As a non-root user (local dev) the process is already
    // unprivileged and setuid is not permitted, so the drop is skipped.
    if (geteuid() == 0) {
      if (setgroups(0, nullptr) != 0 || setgid(65534) != 0 || setuid(65534) != 0) _exit(125);
    }
    // Disallow privilege gain through setuid binaries or file capabilities.
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) _exit(125);
    prctl(PR_SET_DUMPABLE, 0);
    // RLIMIT_FSIZE normally raises SIGXFSZ, which desktop crash reporters
    // mistake for an application crash during intentional output-flood tests.
    // Ignoring it keeps writes capped with EFBIG; the supervisor observes the
    // full file and emits the canonical OUTPUT_LIMIT_EXCEEDED classification.
    signal(SIGXFSZ, SIG_IGN);
    clearenv(); setenv("LANG", "C.UTF-8", 1); setenv("LC_ALL", "C.UTF-8", 1); setenv("TZ", "UTC", 1); setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1);
    std::vector<char*> exec_args;
    exec_args.push_back(const_cast<char*>(o.binary.c_str()));
    for (auto& arg : o.args) exec_args.push_back(arg.data());
    exec_args.push_back(nullptr);
    execvp(o.binary.c_str(), exec_args.data());
    _exit(126);
  }
  setpgid(child, child);
  int status = 0;
  struct rusage usage{};
  bool reaped = false, timed_out = false, memory_exceeded = false, output_exceeded = false, process_exceeded = false;
  long long peak_rss = 0, peak_virtual_kb = 0;
  while (!reaped) {
    pid_t waited = wait4(child, &status, WNOHANG, &usage);
    if (waited == child) { reaped = true; break; }
    if (waited < 0 && errno == ECHILD) { reaped = true; break; }
    peak_rss = std::max(peak_rss, cgroup.active() ? cgroup.peak_memory_kb() : tree_rss_kb(getpid()));
    if (o.address_space_limit && !cgroup.active()) {
      peak_virtual_kb = std::max(peak_virtual_kb, tree_virtual_kb(getpid()));
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    if (file_size(o.output) + file_size(o.error) >= o.output_bytes) output_exceeded = true;
    if (peak_rss > o.memory_kb || cgroup.memory_event("oom") || cgroup.memory_event("oom_kill")) memory_exceeded = true;
    if (static_cast<long long>(process_tree(getpid()).size()) - 1 > o.max_processes) process_exceeded = true;
    if (elapsed > o.wall_ms) timed_out = true;
    if (timed_out || memory_exceeded || output_exceeded || process_exceeded) { kill_group(child, &cgroup); wait4(child, &status, 0, &usage); reaped = true; }
    else usleep(1000);
  }
  peak_rss = std::max(peak_rss, std::max(static_cast<long long>(usage.ru_maxrss), cgroup.peak_memory_kb()));
  if (file_size(o.output) + file_size(o.error) >= o.output_bytes) output_exceeded = true;
  if (WIFSIGNALED(status) && WTERMSIG(status) == SIGXFSZ) output_exceeded = true;
  if (peak_rss > o.memory_kb) memory_exceeded = true;
  const bool abnormal_exit = !WIFEXITED(status) || WEXITSTATUS(status) != 0;
  // On the RLIMIT_AS fallback, allocation failure happens just below the
  // hard ceiling and may surface as bad_alloc/exit(1). Peak VmSize proves the
  // process exhausted its address-space allowance; ordinary low-memory
  // runtime errors remain RUNTIME_ERROR.
  if (o.address_space_limit && !cgroup.active() && abnormal_exit &&
      (peak_virtual_kb * 100 >= o.memory_kb * 95 || peak_rss * 100 >= o.memory_kb * 95)) {
    memory_exceeded = true;
  }
  kill_group(child, &cgroup); // also remove detached descendants after the main process exits

  // As a child subreaper, collect every orphaned descendant so its CPU usage
  // cannot be hidden by forking and exiting the original process.
  struct rusage descendant_usage{};
  while (wait4(-1, nullptr, WNOHANG, &descendant_usage) > 0) {
    usage.ru_utime.tv_sec += descendant_usage.ru_utime.tv_sec;
    usage.ru_utime.tv_usec += descendant_usage.ru_utime.tv_usec;
    usage.ru_stime.tv_sec += descendant_usage.ru_stime.tv_sec;
    usage.ru_stime.tv_usec += descendant_usage.ru_stime.tv_usec;
  }
  const long long cgroup_cpu_ns = cgroup.cpu_time_ns();

  std::string classification = "NORMAL";
  if (timed_out) classification = "TIME_LIMIT_EXCEEDED";
  else if (memory_exceeded) classification = "MEMORY_LIMIT_EXCEEDED";
  else if (output_exceeded) classification = "OUTPUT_LIMIT_EXCEEDED";
  else if (process_exceeded || !WIFEXITED(status) || WEXITSTATUS(status) != 0) classification = "RUNTIME_ERROR";
  std::ofstream metrics(o.metrics);
  metrics << "{\"exitCode\":" << (WIFEXITED(status) ? std::to_string(WEXITSTATUS(status)) : "null")
          << ",\"signal\":" << (WIFSIGNALED(status) ? std::to_string(WTERMSIG(status)) : "null")
          << ",\"wallTimeNs\":" << std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - started).count()
          << ",\"userCpuTimeNs\":" << (cgroup_cpu_ns > 0 ? cgroup_cpu_ns : ns(usage.ru_utime))
          << ",\"systemCpuTimeNs\":" << (cgroup_cpu_ns > 0 ? 0 : ns(usage.ru_stime))
          << ",\"maxRssKb\":" << peak_rss
          << ",\"maxVirtualMemoryKb\":" << peak_virtual_kb
          << ",\"timedOut\":" << (timed_out ? "true" : "false")
          << ",\"memoryExceeded\":" << (memory_exceeded ? "true" : "false")
          << ",\"outputExceeded\":" << (output_exceeded ? "true" : "false")
          << ",\"processLimitExceeded\":" << (process_exceeded ? "true" : "false")
          << ",\"resourceAccounting\":\"" << (cgroup.active() ? "cgroup-v2" : "rlimit-proc-fallback") << "\""
          << ",\"classification\":\"" << classification << "\"}\n";
  return 0;
}
