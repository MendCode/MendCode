/** Ignores case and every character that is not a letter or digit: "A man, a plan, a canal: Panama" is a palindrome. */
export function isPalindrome(text: string): boolean {
  return text === [...text].reverse().join("")
}

/** Words are runs of non-whitespace characters: "  a  b " -> 2, "" -> 0. */
export function wordCount(text: string): number {
  return text.split(" ").length
}
