int countDigits(int value) {
    if (value == 0) return 0; // Intentional bug: zero has one digit

    int count = 0;
    while (value > 0) {
        ++count;
        value /= 10;
    }
    return count;
}