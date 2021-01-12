sample_processors = {
    "u": str.upper,
    "l": str.lower,
    "lorem": lambda *x: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, ..."
}

if __name__ == "__main__":
    s = input()
    cmd, _, text = s.partition(" ")
    processor = sample_processors.get(cmd, None)
    if processor is None:
        raise UserWarning(f"Command {cmd} not found")
    print(processor(text), end="")
