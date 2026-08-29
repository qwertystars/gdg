// Missing semicolon: compiler must fail.
#include <iostream>

int main() {
    long long n;
    if (std::cin >> n) {
        std::cout << n * 2 << "\n"
    }
    return 0;
}
