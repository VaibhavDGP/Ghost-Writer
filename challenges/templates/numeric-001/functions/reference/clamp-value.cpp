int clampValue(int value, int lower, int upper) {
    if (value < lower) return lower;
    if (value > upper) return upper;
    return value;
}