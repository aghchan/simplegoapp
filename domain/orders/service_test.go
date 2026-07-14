package orders

import (
	"context"
	"testing"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

func TestListUnknownCursorReturnsEmptyPage(t *testing.T) {
	svc := NewService(logger.NewService())
	ctx := context.Background()
	svc.Create(ctx, "a", 1)
	svc.Create(ctx, "b", 1)

	page, next, err := svc.List(ctx, 10, "ord_does_not_exist")
	if err != nil || len(page) != 0 || next != "" {
		t.Fatalf("unknown cursor should be past-the-end, got %d items next %q err %v", len(page), next, err)
	}
}

func TestListGuardsNonPositiveLimit(t *testing.T) {
	svc := NewService(logger.NewService())
	svc.Create(context.Background(), "a", 1)

	page, next, err := svc.List(context.Background(), -5, "")
	if err != nil || len(page) != 0 || next != "" {
		t.Fatalf("negative limit should return empty page, got %d items next %q err %v", len(page), next, err)
	}
}
