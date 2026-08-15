package id

import "github.com/google/uuid"

// New returns a UUIDv7 string. Lexical order matches creation order, which is
// what keyset pagination in the domain services relies on — do not swap this
// for a random-ordered id scheme without changing how pages are cut.
func New() string {
	v, err := uuid.NewV7()
	if err != nil {
		return uuid.NewString()
	}

	return v.String()
}
