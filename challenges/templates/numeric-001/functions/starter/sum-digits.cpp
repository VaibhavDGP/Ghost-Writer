int sumDigits(int value) {
    int sum = 0;
    while (value > 10) { // Intentional bug: misses the final digit when value is 10
        sum += value % 10;
        value /= 10;
    }
    return sum + value;
}