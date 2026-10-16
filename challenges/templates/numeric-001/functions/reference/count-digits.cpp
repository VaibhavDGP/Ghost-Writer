int countDigits(int value) {
    if (value == 0) return 1;

    int count = 0;
    while (value > 0) {
        ++count;
        value /= 10;
    }
    return count;
}