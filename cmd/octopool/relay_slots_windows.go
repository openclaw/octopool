package main

import (
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

func fallbackRelaySlotDirectory() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	sid := user.User.Sid
	directory := filepath.Join(os.TempDir(), "octopool-relay-slots-"+sid.String())
	// Windows needs a protected DACL: os.Mkdir's mode does not restrict access.
	sd, err := windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;OICI;FA;;;" + sid.String() + ")")
	if err != nil {
		return "", err
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	name, err := windows.UTF16PtrFromString(directory)
	if err != nil {
		return "", err
	}
	if err := windows.CreateDirectory(name, &attributes); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return "", err
	}
	file, closeFile, err := openRewriteWindowsPath(directory, true)
	if err != nil {
		return "", err
	}
	defer closeFile()
	if err := checkRewritePrivateWindowsDirectory(file, sid); err != nil {
		return "", err
	}
	return directory, nil
}

func tryLockRelaySlot(file *os.File) (bool, error) {
	var overlapped windows.Overlapped
	err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return false, nil
	}
	return err == nil, err
}
