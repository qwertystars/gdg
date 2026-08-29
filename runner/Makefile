CXX ?= g++
CXXFLAGS ?= -std=c++17 -O2 -pipe

.PHONY: all clean
all: judge-runner

judge-runner: judge-runner.cpp
	$(CXX) $(CXXFLAGS) $< -o $@

clean:
	rm -f judge-runner
