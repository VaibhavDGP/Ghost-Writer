#include <iostream>
#include <string>
#include "../functions/starter/clamp-value.cpp"
#include "../functions/starter/sum-digits.cpp"
#include "../functions/starter/count-digits.cpp"

int main() {
    std::string operation;
    std::cin >> operation;

    if (operation == "clamp") {
        int value, lower, upper;
        std::cin >> value >> lower >> upper;
        std::cout << clampValue(value, lower, upper) << '\n';
    } else if (operation == "sum") {
        int value;
        std::cin >> value;
        std::cout << sumDigits(value) << '\n';
    } else if (operation == "count") {
        int value;
        std::cin >> value;
        std::cout << countDigits(value) << '\n';
    } else {
        return 1;
    }

    return 0;
}